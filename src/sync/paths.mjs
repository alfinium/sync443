// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Local folder paths, as the WebExtension folder API writes them: "/" then
 * the folder names from the top, joined with "/" ("/Inbox/Clients").
 */

/** A folder path as the engine stores and passes it. */
export const validPath = (p) => typeof p === "string" && p.startsWith("/") && p.length <= 2048;

/** The parent's path ("/" at the top). */
export const dirname = (p) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

/** The last segment of a path. */
export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/** The path of `name` in the folder `parent`. */
export const join = (parent, name) => (parent === "/" ? `/${name}` : `${parent}/${name}`);

/** `path` is `root` or inside it. */
export const under = (path, root) => path === root || path.startsWith(`${root}/`);

/** `path` (`from` or inside it) once `from` has become `to`. */
export const rebase = (path, from, to) => (path === from ? to : `${to}${path.slice(from.length)}`);
