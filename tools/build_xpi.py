# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Build the extension package, reproducibly: dist/sync443-<version>.xpi.

The package is src/ as it is (every file, sorted by name, with a fixed date
and fixed permissions, so that the same sources give the same bytes with the
same zlib), with one exception: in src/background.mjs, the lines between
"// <test-hooks>" and "// </test-hooks>" (the hooks of the end-to-end tests)
are removed, so that a published package holds no test code. Junk left by file managers (.DS_Store, Thumbs.db,
desktop.ini) is skipped; any other unexpected file (hidden, link, unknown
type, name that only differs by case) stops the build, and so does test
material: a published package never contains test-config.json,
test-scenario.mjs or anything else whose name starts with "test-".

    python3 -I tools/build_xpi.py                           check, then build
    python3 -I tools/build_xpi.py --check                   check only
    python3 -I tools/build_xpi.py --expect-version v0.1.0   the manifest must have this version (release tag)
    python3 -I tools/build_xpi.py --notes dist/notes.md     also write the CHANGELOG.md section of that version

(Windows: py -3 -I tools\\build_xpi.py.)

Checks: the manifest is valid JSON without duplicate keys, with the fields a
release needs; every file it names exists in src/; every experiment schema
is valid JSON; every local file an HTML page names (src, href) exists; every
relative module import of a .mjs or .js file resolves to a file in src/.
Translations: src/_locales/<language>/messages.json, nothing else in
_locales; each catalogue valid JSON without duplicate keys, every message a
non-empty text; the manifest's default_locale has its catalogue, every
__MSG_key__ of the manifest is in it, and every other catalogue has the same
messages with the same placeholders (tests/unit/i18n.test.mjs checks the
rest: every key used exists, the texts of each language compose correctly).
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import unicodedata
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
EXTENSION_ID = "sync443@alfinium.github.io"

FIXED_TIME = (1980, 1, 1, 0, 0, 0)  # the earliest date a zip entry can carry
JUNK = {".DS_Store", "Thumbs.db", "desktop.ini"}
SHIPPED = {".mjs", ".js", ".json", ".html", ".css", ".svg", ".png"}
NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$")
# Test material (test-config.json, test-scenario.mjs of the end-to-end tests, any other
# file or folder named "test-..."): never in a published package.
TEST_PREFIX = "test-"
# Blocks of test code removed from the published package (whole lines, in this file only).
HOOKS_FILE = "background.mjs"
HOOK_BEGIN = "// <test-hooks>"
HOOK_END = "// </test-hooks>"
# What must be gone once they are removed.
HOOK_LEFTOVERS = ("test-config.json", "test-scenario.mjs", "runScenario", "loadTestConfig")
VERSION = re.compile(r"^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){1,3}$")

# Relative module specifiers: static imports and re-exports (statements
# starting a line, so that examples in comments are not taken), and import().
STATIC_IMPORT = re.compile(r"""^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["'](\.{1,2}/[^"'\n]+)["']""", re.M)
BARE_IMPORT = re.compile(r"""^[ \t]*import[ \t]*["'](\.{1,2}/[^"'\n]+)["']""", re.M)
DYNAMIC_IMPORT = re.compile(r"""\bimport\(\s*["'](\.{1,2}/[^"'\n]+)["']\s*\)""")
HTML_REF = re.compile(r"""\b(?:src|href)\s*=\s*["']([^"']*)["']""", re.I)
EXTERNAL = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//|#)", re.I)
# Translations: _locales/<language>/messages.json ("en", "fr", "pt_BR"…).
LOCALES = "_locales"
LOCALE_FILE = re.compile(r"^_locales/([a-z]{2,3}(?:_[A-Z]{2})?)/messages\.json$")
MESSAGE_NAME = re.compile(r"^[A-Za-z0-9_@]+$")
# Spaces a message may contain: the ordinary space, and the no-break spaces of French and Japanese typography.
MESSAGE_SPACES = {chr(0x20), chr(0xA0), chr(0x202F), chr(0x3000)}
MESSAGE_LINK = re.compile(r"://|\b(?:javascript|data|vbscript):", re.IGNORECASE)


def unsafe_message(text):
    """Why a translated message may not be shown as text, or None: a character that is not visible
    text (controls, format and bidirectional marks, other spaces, private or unassigned), markup, a link."""
    for ch in text:
        category = unicodedata.category(ch)
        if category[0] == "C" or category in ("Zl", "Zp") or (category == "Zs" and ch not in MESSAGE_SPACES):
            return f"caractère non visible U+{ord(ch):04X}"
    if "<" in text or ">" in text:
        return "balise (< ou >)"
    if MESSAGE_LINK.search(text):
        return "lien"
    return None
MANIFEST_MESSAGE = re.compile(r"__MSG_([A-Za-z0-9_@]+)__")


class BuildError(Exception):
    pass


def rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


def _no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"clé en double : {key}")
        out[key] = value
    return out


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f, object_pairs_hook=_no_duplicates)
    except (OSError, ValueError) as e:
        raise BuildError(f"{rel(path)} : JSON invalide ({e})")


def collect():
    """[(name in the package, path)], sorted by name."""
    files = []
    seen = {}
    for base, dirs, names in os.walk(SRC):
        for d in dirs:
            if os.path.islink(os.path.join(base, d)):
                raise BuildError(f"lien symbolique refusé : {rel(os.path.join(base, d))}")
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for n in sorted(names):
            if n in JUNK:
                continue
            path = os.path.join(base, n)
            arc = os.path.relpath(path, SRC).replace(os.sep, "/")
            if os.path.islink(path):
                raise BuildError(f"lien symbolique refusé : src/{arc}")
            if any(part.lower().startswith(TEST_PREFIX) for part in arc.split("/")):
                raise BuildError(f"matériel de test refusé dans un paquet publié : src/{arc} (à retirer de src/ avant la construction)")
            if not NAME.match(arc):
                raise BuildError(f"nom de fichier inattendu (caché ou caractère spécial) : src/{arc}")
            if os.path.splitext(n)[1] not in SHIPPED:
                raise BuildError(f"fichier inattendu, d'un type qui n'est pas publié : src/{arc}")
            # Windows and macOS do not tell these apart.
            folded = arc.lower()
            if folded in seen:
                raise BuildError(f"noms qui ne diffèrent que par la casse : src/{seen[folded]} et src/{arc}")
            seen[folded] = arc
            files.append((arc, path))
    files.sort(key=lambda item: item[0].encode("ascii"))
    return files


def published(arc, data):
    """The bytes of `arc` as published: test-hook blocks removed (see HOOK_BEGIN)."""
    text = data.decode("utf-8")
    lines = text.split("\n")
    markers = [i for i, line in enumerate(lines) if line.strip() in (HOOK_BEGIN, HOOK_END)]
    if arc != HOOKS_FILE:
        if markers:
            raise BuildError(f"src/{arc} : bloc de test hors de src/{HOOKS_FILE}")
        return data
    if not markers:
        raise BuildError(f"src/{arc} : aucun bloc de test marqué (attendu entre {HOOK_BEGIN} et {HOOK_END})")
    out = []
    inside = False
    for i, line in enumerate(lines):
        mark = line.strip()
        if mark == HOOK_BEGIN:
            if inside:
                raise BuildError(f"src/{arc}, ligne {i + 1} : bloc de test ouvert deux fois")
            inside = True
        elif mark == HOOK_END:
            if not inside:
                raise BuildError(f"src/{arc}, ligne {i + 1} : fin de bloc de test sans début")
            inside = False
        elif not inside:
            out.append(line)
    if inside:
        raise BuildError(f"src/{arc} : bloc de test jamais fermé")
    result = "\n".join(out)
    for word in HOOK_LEFTOVERS:
        if word in result:
            raise BuildError(f"src/{arc} : code de test hors des blocs marqués ({word})")
    return result.encode("utf-8")


def manifest_refs(m):
    """[(where in the manifest, path)] of every file the manifest names."""
    refs = []
    background = m.get("background") or {}
    for script in background.get("scripts") or []:
        refs.append(("background.scripts", script))
    if "page" in background:
        refs.append(("background.page", background["page"]))
    options = m.get("options_ui") or {}
    if "page" in options:
        refs.append(("options_ui.page", options["page"]))
    for key in ("browser_action", "compose_action", "message_display_action"):
        section = m.get(key) or {}
        icon = section.get("default_icon")
        if isinstance(icon, dict):
            refs.extend((f"{key}.default_icon.{size}", p) for size, p in icon.items())
        elif icon is not None:
            refs.append((f"{key}.default_icon", icon))
        for i, theme in enumerate(section.get("theme_icons") or []):
            for side in ("light", "dark"):
                refs.append((f"{key}.theme_icons[{i}].{side}", (theme or {}).get(side)))
        if "default_popup" in section:
            refs.append((f"{key}.default_popup", section["default_popup"]))
    for size, p in (m.get("icons") or {}).items():
        refs.append((f"icons.{size}", p))
    for name, api in (m.get("experiment_apis") or {}).items():
        refs.append((f"experiment_apis.{name}.schema", (api or {}).get("schema")))
        for side in ("parent", "child"):
            if side in (api or {}):
                refs.append((f"experiment_apis.{name}.{side}.script", (api[side] or {}).get("script")))
    return refs


def resolve(base_dir, ref):
    """Absolute path of `ref` (relative to base_dir, inside src/), or None if it leaves src/."""
    path = os.path.normpath(os.path.join(base_dir, ref.replace("/", os.sep)))
    inside = os.path.normcase(path).startswith(os.path.normcase(SRC) + os.sep)
    return path if inside else None


def manifest_strings(value):
    """Every string of the manifest, however deep."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from manifest_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from manifest_strings(v)


def check_locales(files, manifest):
    """→ ({language: {key: message}}, [problem]) for src/_locales and the manifest's default_locale."""
    problems = []
    catalogues = {}
    shapes = {}  # language → {key: {placeholder: content}}
    for arc, path in files:
        if not (arc == LOCALES or arc.startswith(LOCALES + "/")):
            continue
        m = LOCALE_FILE.match(arc)
        if not m:
            problems.append(f"src/{arc} : fichier inattendu dans {LOCALES} (seulement <langue>/messages.json)")
            continue
        try:
            data = load_json(path)
        except BuildError as e:
            problems.append(str(e))
            continue
        if not isinstance(data, dict) or not data:
            problems.append(f"src/{arc} : objet JSON de messages attendu")
            continue
        messages = {}
        placeholders = {}
        names = {}  # lower case → name as written: Thunderbird keeps only one of two names differing by case
        for key, entry in data.items():
            text = entry.get("message") if isinstance(entry, dict) else None
            if not MESSAGE_NAME.match(key):
                problems.append(f"src/{arc} : nom de message invalide : {key!r}")
            elif key.lower() in names:
                problems.append(f"src/{arc} : noms de message identiques à la casse près : {names[key.lower()]}, {key}")
            elif not isinstance(text, str) or not text.strip():
                problems.append(f"src/{arc} : message vide ou absent : {key}")
            elif unsafe_message(text):
                problems.append(f"src/{arc} : {key} : {unsafe_message(text)}")
            else:
                messages[key.lower()] = text
                found = entry.get("placeholders") or {}
                placeholders[key.lower()] = {
                    str(name).lower(): (p.get("content") if isinstance(p, dict) else None) for name, p in found.items()
                } if isinstance(found, dict) else None
            names.setdefault(key.lower(), key)
        catalogues[m.group(1)] = messages
        shapes[m.group(1)] = placeholders

    default = manifest.get("default_locale")
    used = sorted({k for s in manifest_strings(manifest) for k in MANIFEST_MESSAGE.findall(s)})
    if default is None:
        if catalogues:
            problems.append(f"default_locale absent du manifeste, alors que src/{LOCALES} existe")
        if used:
            problems.append(f"__MSG_…__ dans le manifeste sans default_locale : {', '.join(used)}")
        return catalogues, problems
    if not isinstance(default, str) or default not in catalogues:
        problems.append(f"default_locale {default!r} : src/{LOCALES}/{default}/messages.json absent")
        return catalogues, problems
    for key in used:
        if key.lower() not in catalogues[default]:
            problems.append(f"manifeste : __MSG_{key}__ absent de src/{LOCALES}/{default}/messages.json")
    # Every translation has every message of the default language, with the same placeholders.
    reference = shapes[default]
    for lang, shape in sorted(shapes.items()):
        if lang == default:
            continue
        where = f"src/{LOCALES}/{lang}/messages.json"
        missing = sorted(set(reference) - set(shape))
        extra = sorted(set(shape) - set(reference))
        if missing:
            problems.append(f"{where} : messages absents : {', '.join(missing)}")
        if extra:
            problems.append(f"{where} : messages inconnus de la langue par défaut : {', '.join(extra)}")
        for key in sorted(set(reference) & set(shape)):
            if shape[key] != reference[key]:
                problems.append(f"{where} : {key} : paramètres différents de la langue par défaut")
    return catalogues, problems


def localized(text, catalogue):
    """`text` of the manifest with its __MSG_key__ replaced from `catalogue` (unknown keys left as they are)."""
    return MANIFEST_MESSAGE.sub(lambda m: catalogue.get(m.group(1).lower(), m.group(0)), text)


def check(files, expect_version=None):
    """→ (manifest, [problem])."""
    problems = []
    manifest = load_json(os.path.join(SRC, "manifest.json"))
    if not isinstance(manifest, dict):
        raise BuildError("src/manifest.json : objet JSON attendu")

    catalogues, locale_problems = check_locales(files, manifest)
    problems.extend(locale_problems)
    default_catalogue = catalogues.get(manifest.get("default_locale"), {})

    if manifest.get("manifest_version") != 2:
        problems.append("manifest_version doit valoir 2")
    for key in ("name", "description"):
        value = manifest.get(key)
        if not isinstance(value, str) or not localized(value, default_catalogue).strip():
            problems.append(f"champ « {key} » absent du manifeste")
    version = manifest.get("version")
    if not isinstance(version, str) or not VERSION.match(version):
        problems.append(f"version invalide dans le manifeste : {version!r}")
    gecko = (manifest.get("browser_specific_settings") or {}).get("gecko") or {}
    if gecko.get("id") != EXTENSION_ID:
        problems.append(f"identifiant de l'extension inattendu : {gecko.get('id')!r} (attendu {EXTENSION_ID})")
    if not isinstance(gecko.get("strict_min_version"), str):
        problems.append("strict_min_version absent du manifeste")
    if expect_version is not None:
        wanted = expect_version[1:] if expect_version.startswith("v") else expect_version
        if not VERSION.match(wanted):
            problems.append(f"version attendue invalide : {expect_version!r}")
        elif wanted != version:
            problems.append(f"la version du manifeste ({version}) n'est pas la version attendue ({wanted})")

    for where, ref in manifest_refs(manifest):
        if not isinstance(ref, str) or not ref or ref.startswith(("/", "\\")) or "\\" in ref or EXTERNAL.match(ref):
            problems.append(f"manifeste, {where} : chemin invalide {ref!r}")
            continue
        path = resolve(SRC, ref)
        if path is None or not os.path.isfile(path):
            problems.append(f"manifeste, {where} : fichier absent : src/{ref}")
        elif where.endswith(".schema"):
            try:
                load_json(path)
            except BuildError as e:
                problems.append(str(e))

    for arc, path in files:
        ext = os.path.splitext(arc)[1]
        if ext not in (".html", ".mjs", ".js"):
            continue
        with open(path, "rb") as f:
            try:
                text = published(arc, f.read()).decode("utf-8")
            except BuildError as e:
                problems.append(str(e))
                continue
        base_dir = os.path.dirname(path)
        if ext == ".html":
            refs = [r for r in HTML_REF.findall(text) if r and not EXTERNAL.match(r)]
        else:
            refs = STATIC_IMPORT.findall(text) + BARE_IMPORT.findall(text) + DYNAMIC_IMPORT.findall(text)
        for ref in refs:
            target = resolve(base_dir, re.split(r"[?#]", ref, maxsplit=1)[0])
            if target is None:
                problems.append(f"src/{arc} : {ref} sort de src/")
            elif not os.path.isfile(target):
                problems.append(f"src/{arc} : fichier absent : {ref}")
    return manifest, problems


def release_notes(version):
    """The CHANGELOG.md section of `version` ("## 0.1.0" or "## [0.1.0] …"), without its heading."""
    fallback = f"Sync443 {version}.\n"
    if not os.path.isfile(CHANGELOG):
        return fallback
    with open(CHANGELOG, encoding="utf-8") as f:
        lines = f.read().splitlines()
    heading = re.compile(r"^##\s+\[?v?" + re.escape(version) + r"\]?(?:\s|$)")
    out = []
    inside = False
    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            inside = bool(heading.match(line))
            continue
        if inside:
            out.append(line)
    text = "\n".join(out).strip()
    return text + "\n" if text else fallback


def build(files, version):
    """Write the package; → (path, bytes)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for arc, path in files:
            with open(path, "rb") as f:
                data = published(arc, f.read())
            info = zipfile.ZipInfo(arc, FIXED_TIME)
            info.create_system = 3  # the same on every OS
            info.external_attr = 0o100644 << 16  # regular file, rw-r--r--
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    data = buf.getvalue()
    os.makedirs(DIST, exist_ok=True)
    target = os.path.join(DIST, f"sync443-{version}.xpi")
    tmp = target + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, target)
    return target, data


def main(argv=None):
    # Windows consoles are not UTF-8 by default: the messages are in French.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Construit dist/sync443-<version>.xpi de façon reproductible.")
    parser.add_argument("--check", action="store_true", help="vérifier seulement, sans construire")
    parser.add_argument("--expect-version", metavar="VERSION", help="version attendue (une étiquette vX.Y.Z convient)")
    parser.add_argument("--notes", metavar="FICHIER", help="écrire dans FICHIER la section de CHANGELOG.md de cette version")
    args = parser.parse_args(argv)

    try:
        files = collect()
        manifest, problems = check(files, args.expect_version)
    except BuildError as e:
        print(f"Échec : {e}")
        return 1
    if problems:
        for problem in problems:
            print(f"  - {problem}")
        print(f"Échec : {len(problems)} problème(s).")
        return 1
    version = manifest["version"]
    print(f"Vérifications réussies : {len(files)} fichiers, version {version}.")

    if args.notes:
        notes_dir = os.path.dirname(os.path.abspath(args.notes))
        os.makedirs(notes_dir, exist_ok=True)
        with open(args.notes, "w", encoding="utf-8", newline="\n") as f:
            f.write(release_notes(version))
        print(f"Notes de version : {args.notes}")
    if args.check:
        return 0
    target, data = build(files, version)
    print(f"{rel(target)} : {len(data)} octets, SHA-256 {hashlib.sha256(data).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
