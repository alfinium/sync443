// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * TEST ONLY: helpers for the sync443Calendar end-to-end test, and for the
 * calendar scenario of the mail end-to-end runner
 * (tests/e2e/mail/calendar-scenario.mjs, which packages this experiment
 * too). Never part of the shipped extension. They act on calendars the way
 * Thunderbird's own interface does (through the registered calendar
 * objects, and through Thunderbird's transactions and iTIP processing for
 * the "ui…" and "itip…" helpers), read items back through Thunderbird's own
 * API, create calendars the extension does not own, count notifications,
 * and watch what Thunderbird's scheduling code would send. All in a
 * throw-away profile.
 *
 * Results go to <profile>/sync443calendar-e2e.txt (and to stdout).
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, Cr, Components, IOUtils, PathUtils */

// eslint-disable-next-line no-var, no-unused-vars
var sync443CalendarTest = (() => {
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { ExtensionError } = ExtensionUtils;
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  const { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
  const { CalTodo } = ChromeUtils.importESModule("resource:///modules/CalTodo.sys.mjs");
  const { CalAttendee } = ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs");
  const { CalAlarm } = ChromeUtils.importESModule("resource:///modules/CalAlarm.sys.mjs");
  const { CalRecurrenceInfo } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs");
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

  const RESULTS = "sync443calendar-e2e.txt";
  const PHASE = "sync443calendar-phase.json";
  const REGISTRY = "calendar.registry.";
  const ALL = Ci.calICalendar.ITEM_FILTER_ALL_ITEMS;
  let queue = Promise.resolve();
  const watchers = new Map(); // calendar id → { observer, counts }
  const sent = { calls: 0 }; // what Thunderbird's scheduling code handed to a transport

  function print(line) {
    const text = `${line}\n`;
    dump(text);
    queue = queue
      .then(() => IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, RESULTS), text, { mode: "appendOrCreate" }))
      .catch((e) => dump(`sync443CalendarTest: cannot write the results file: ${e}\n`));
    return queue;
  }

  const pad = (n) => String(n).padStart(2, "0");

  function calendarById(id) {
    const found = cal.manager.getCalendars().find((c) => c.id === id);
    if (!found) throw new Error(`no calendar ${id}`);
    return found;
  }

  function prefsUnder(prefix) {
    const out = {};
    for (const name of Services.prefs.getChildList(prefix).sort()) {
      const type = Services.prefs.getPrefType(name);
      if (type === Ci.nsIPrefBranch.PREF_STRING) out[name] = Services.prefs.getStringPref(name);
      else if (type === Ci.nsIPrefBranch.PREF_INT) out[name] = Services.prefs.getIntPref(name);
      else if (type === Ci.nsIPrefBranch.PREF_BOOL) out[name] = Services.prefs.getBoolPref(name);
    }
    return out;
  }

  // ── Items read through Thunderbird's API ──────────────────────────────

  function when(dt) {
    if (!dt) return null;
    const day = `${dt.year}-${pad(dt.month + 1)}-${pad(dt.day)}`;
    if (dt.isDate) return { date: true, tzid: dt.timezone.tzid, local: day, utc: null, offset: null };
    return {
      date: false,
      tzid: dt.timezone.tzid,
      local: `${day}T${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}`,
      utc: `${new Date(dt.nativeTime / 1000).toISOString().slice(0, 19)}Z`,
      offset: dt.timezoneOffset,
    };
  }

  function person(a) {
    return { id: a.id, cn: a.commonName ?? null, role: a.role ?? null, partstat: a.participationStatus ?? null, type: a.userType ?? null, rsvp: a.rsvp ?? null };
  }

  function plain(item) {
    const out = {
      id: item.id,
      kind: item.isEvent() ? "event" : "task",
      calendarId: item.calendar?.id ?? null,
      title: item.title ?? null,
      location: item.getProperty("LOCATION") ?? null,
      description: item.getProperty("DESCRIPTION") ?? null,
      start: when(item.isEvent() ? item.startDate : item.entryDate),
      end: item.isEvent() ? when(item.endDate) : null,
      due: item.isTodo() ? when(item.dueDate) : null,
      transp: item.getProperty("TRANSP") ?? null,
      privacy: item.privacy ?? null,
      status: item.status ?? null,
      priority: item.priority ?? null,
      sequence: item.getProperty("SEQUENCE") ?? null,
      stamp: when(item.getProperty("DTSTAMP")),
      completed: item.isTodo() ? !!item.isCompleted : null,
      completedAt: item.isTodo() ? when(item.completedDate) : null,
      percent: item.isTodo() ? item.percentComplete : null,
      categories: item.getCategories(),
      alarms: item.getAlarms().map((a) => ({ related: a.related, offset: a.offset ? a.offset.inSeconds : null, at: when(a.alarmDate), action: a.action })),
      organizer: item.organizer ? { id: item.organizer.id, cn: item.organizer.commonName ?? null } : null,
      attendees: item.getAttendees().map(person),
      lastAck: when(item.alarmLastAck),
      x: {},
      recurrenceId: when(item.recurrenceId),
      rules: [],
      removed: [],
      exceptions: [],
    };
    for (const [name, value] of item.properties) {
      if (name.startsWith("X-") && value !== null) out.x[name] = String(value);
    }
    const info = item.recurrenceId ? null : item.recurrenceInfo;
    if (info) {
      for (const entry of info.getRecurrenceItems()) {
        const one = entry.wrappedJSObject ?? entry;
        if (typeof one.getComponent === "function") out.rules.push(one.icalString.trim());
        else out.removed.push({ ...when(one.date), negative: one.isNegative });
      }
      for (const id of info.getExceptionIds()) out.exceptions.push(plain(info.getExceptionFor(id)));
      out.exceptions.sort((a, b) => (a.recurrenceId.utc ?? a.recurrenceId.local).localeCompare(b.recurrenceId.utc ?? b.recurrenceId.local));
    }
    return out;
  }

  // ── Items made as the interface makes them ────────────────────────────

  /** "20270310T090000" in a zone, or "20270310" for a whole day. */
  function date(text, tzid) {
    const dt = cal.createDateTime(text);
    if (text.length > 8) dt.timezone = tzid ? cal.timezoneService.getTimezone(tzid) : cal.timezoneService.defaultTimezone;
    return dt;
  }

  const utc = (text) => cal.createDateTime(text.replace(/[-:]/g, ""));

  function attendee(spec, organizer = false) {
    const a = new CalAttendee();
    a.id = spec.id;
    if (spec.cn) a.commonName = spec.cn;
    if (organizer) a.isOrganizer = true;
    else {
      a.role = spec.role ?? "REQ-PARTICIPANT";
      a.participationStatus = spec.partstat ?? "NEEDS-ACTION";
      a.rsvp = spec.rsvp ?? "TRUE";
    }
    return a;
  }

  function alarm(minutes) {
    const a = new CalAlarm();
    a.action = "DISPLAY";
    a.related = Ci.calIAlarm.ALARM_RELATED_START;
    const offset = cal.createDuration();
    offset.inSeconds = -minutes * 60;
    a.offset = offset;
    return a;
  }

  function rule(text) {
    const r = cal.createRecurrenceRule();
    r.icalString = `RRULE:${text}`;
    return r;
  }

  /** One change, the way a dialog of Thunderbird applies it to a copy of the item. */
  function apply(item, op) {
    if ("title" in op) item.title = op.title;
    if ("location" in op) item.setProperty("LOCATION", op.location);
    if ("description" in op) item.setProperty("DESCRIPTION", op.description);
    if ("prop" in op) item.setProperty(op.prop, op.value);
    if ("transp" in op) item.setProperty("TRANSP", op.transp);
    if ("privacy" in op) item.privacy = op.privacy;
    if ("categories" in op) item.setCategories(op.categories);
    if ("shift" in op) {
      const by = cal.createDuration();
      by.inSeconds = op.shift * 60;
      const [start, end] = [item.startDate.clone(), item.endDate.clone()];
      start.addDuration(by);
      end.addDuration(by);
      item.startDate = start;
      item.endDate = end;
    }
    if ("lastAck" in op) item.alarmLastAck = utc(op.lastAck);
    if ("alarm" in op) {
      item.clearAlarms();
      if (op.alarm !== null) item.addAlarm(alarm(op.alarm));
    }
    if ("partstat" in op) {
      const old = item.getAttendeeById(op.partstat.id);
      const changed = old.clone();
      changed.participationStatus = op.partstat.value;
      item.removeAttendee(old);
      item.addAttendee(changed);
    }
    if ("addAttendee" in op) item.addAttendee(attendee(op.addAttendee));
    if ("addAttendees" in op) for (const one of op.addAttendees) item.addAttendee(attendee(one));
    if ("removeAttendee" in op) item.removeAttendee(item.getAttendeeById(op.removeAttendee));
    if ("rrule" in op) {
      const info = new CalRecurrenceInfo(item);
      for (const text of [].concat(op.rrule)) info.appendRecurrenceItem(rule(text));
      item.recurrenceInfo = info;
    }
    if ("rdate" in op) {
      const extra = cal.createRecurrenceDate();
      extra.date = utc(op.rdate);
      item.recurrenceInfo.appendRecurrenceItem(extra);
    }
    if ("complete" in op) item.isCompleted = op.complete;
    if ("priority" in op) item.priority = op.priority;
  }

  function make(spec) {
    const item = spec.kind === "task" ? new CalTodo() : new CalEvent();
    if (spec.id) item.id = spec.id;
    if (spec.kind === "task") {
      if (spec.start) item.entryDate = date(spec.start, spec.tzid);
      if (spec.due) item.dueDate = date(spec.due, spec.tzid);
    } else {
      item.startDate = date(spec.start, spec.tzid);
      item.endDate = date(spec.end, spec.tzid);
    }
    if (spec.organizer) item.organizer = attendee(spec.organizer, true);
    for (const a of spec.attendees ?? []) item.addAttendee(attendee(a));
    for (const op of spec.ops ?? []) apply(item, op);
    return item;
  }

  // ── Scheduling: what would be sent ────────────────────────────────────

  function spyTransport() {
    return {
      QueryInterface: ChromeUtils.generateQI(["calIItipTransport"]),
      scheme: "mailto",
      type: "email",
      senderAddress: null,
      calls: 0,
      sendItems() {
        this.calls++;
        return true;
      },
    };
  }

  /** Replaces every way Thunderbird has to send a scheduling mail by a counter; returns what puts them back. */
  function watchSending(calendar) {
    const mod = ChromeUtils.importESModule("resource:///modules/CalItipEmailTransport.sys.mjs");
    const undo = [];
    const count = function () {
      sent.calls++;
      return true;
    };
    for (const name of ["CalItipEmailTransport", "CalItipDefaultEmailTransport"]) {
      const proto = mod[name]?.prototype;
      if (!proto || !Object.hasOwn(proto, "sendItems")) continue;
      const original = proto.sendItems;
      proto.sendItems = count;
      undo.push(() => (proto.sendItems = original));
    }
    const usual = cal.provider.defaultImipTransport;
    const own = Object.hasOwn(usual, "sendItems") ? usual.sendItems : undefined;
    usual.sendItems = count;
    undo.push(() => (own === undefined ? delete usual.sendItems : (usual.sendItems = own)));
    const ours = calendar?.getProperty("itip.transport");
    if (ours && ours !== usual) {
      const original = ours.sendItems;
      ours.sendItems = count;
      undo.push(() => (ours.sendItems = original));
    }
    sent.calls = 0;
    return () => undo.forEach((f) => f());
  }

  // ── The user's actions through Thunderbird's interface code ──────────

  /** Everything Thunderbird's scheduling code and its outgoing mail code did since watchAllSending(). */
  const session = { watching: false, transports: [], smtp: { connects: 0, sends: 0, watched: [] }, wrapped: new WeakSet() };

  /** What a transport was asked to send: the calendar it is for, and the iTIP method. */
  function sendingNote(transport, args) {
    const note = { transport, calendarId: null, method: null, recipients: 0 };
    try {
      note.recipients = args[0]?.length ?? 0;
      const itipItem = args[1];
      note.method = itipItem?.responseMethod ?? null;
      note.calendarId = itipItem?.targetCalendar?.id ?? itipItem?.getItemList?.()[0]?.calendar?.id ?? null;
    } catch {
      // counted all the same
    }
    return note;
  }

  /** The transport of one of our calendars: it sends nothing, and Thunderbird should not even call it. */
  function watchTransportOf(calendar) {
    const transport = calendar?.getProperty("itip.transport");
    if (!session.watching || !transport || transport === cal.provider.defaultImipTransport || session.wrapped.has(transport)) return;
    session.wrapped.add(transport);
    const original = transport.sendItems;
    transport.sendItems = function (...args) {
      session.transports.push({ ...sendingNote("calendar", args), calendarId: calendar.id });
      return original.apply(this, args);
    };
  }

  /**
   * Until Thunderbird quits: every mail transport of Thunderbird's scheduling
   * code counts what it is given instead of sending it, and every SMTP
   * connection or sending Thunderbird attempts is counted (and goes on).
   */
  function watchAllSending() {
    if (session.watching) return;
    session.watching = true;
    const counter = (name) =>
      function (...args) {
        session.transports.push(sendingNote(name, args));
        return true;
      };
    const mod = ChromeUtils.importESModule("resource:///modules/CalItipEmailTransport.sys.mjs");
    for (const name of ["CalItipEmailTransport", "CalItipDefaultEmailTransport"]) {
      const proto = mod[name]?.prototype;
      if (proto && Object.hasOwn(proto, "sendItems")) proto.sendItems = counter(name);
    }
    cal.provider.defaultImipTransport.sendItems = counter("default");
    for (const [file, name, method, key] of [["SmtpClient", "SmtpClient", "connect", "connects"], ["SmtpServer", "SmtpServer", "sendMailMessage", "sends"]]) {
      try {
        const proto = ChromeUtils.importESModule(`resource:///modules/${file}.sys.mjs`)[name].prototype;
        const original = proto[method];
        if (typeof original !== "function") continue;
        proto[method] = function (...args) {
          session.smtp[key]++;
          return original.apply(this, args);
        };
        session.smtp.watched.push(`${name}.${method}`);
      } catch {
        // reported by what `watched` lacks
      }
    }
  }

  /**
   * One transaction of Thunderbird (CalTransactionManager), as its event
   * dialog and its views commit them: the calendar's own addItem, modifyItem
   * or deleteItem, then Thunderbird's scheduling step
   * (cal.itip.checkAndSend), told not to ask before sending.
   */
  async function transact(kind, item, calendar, oldItem, mode) {
    const transactions = ChromeUtils.importESModule("resource:///modules/CalTransactionManager.sys.mjs");
    watchTransportOf(calendar);
    const transaction = new transactions[kind](item, calendar, oldItem, responseOf(mode));
    await transactions.CalTransactionManager.getInstance().commit(transaction);
    return transaction.item;
  }

  /**
   * What Thunderbird's interface passes along with a change for its
   * scheduling step: "AUTO" (send a response now; the default here), "NONE"
   * (do not send a response), "USER" (ask the user), or "DEFAULT" for
   * nothing at all, which Thunderbird reads as "USER".
   */
  function responseOf(mode) {
    if (mode === "DEFAULT") return null;
    return { responseMode: Ci.calIItipItem[["NONE", "USER"].includes(mode) ? mode : "AUTO"] };
  }

  // ── Faults put into Thunderbird's own code, each one undone by the same helper ──

  const heldItems = new Map(); // "calendar/item" → a copy of the item kept by the helper `access`
  const faults = { inserts: new Map(), expansion: null, directory: null, proxies: null };

  /** Our provider object for a calendar id, and its inner storage calendar as Thunderbird's storage code sees it. */
  function innerStore(calendarId) {
    const store = calendarById(calendarId).wrappedJSObject.store;
    return store.wrappedJSObject ?? store;
  }

  /** A connection of our own to the store of our calendars. */
  function ownConnection() {
    const file = cal.provider.getCalendarDirectory();
    file.append("sync443.sqlite");
    return Services.storage.openDatabase(file);
  }

  /**
   * "Notify attendees", as the event dialog leaves it on an item with
   * attendees: checked ("TRUE"), or absent when the calendar says it tells
   * the attendees itself. `forced`: checked whatever the calendar says, so
   * that Thunderbird means to send everything it could.
   */
  function markNotify(item, calendar, forced) {
    if (!item.getAttendees().length) return;
    let own = false;
    try {
      const support = calendar.QueryInterface(Ci.calISchedulingSupport);
      own = support.canNotify("REQUEST", item) && support.canNotify("CANCEL", item);
    } catch {
      own = false;
    }
    if (own && !forced) item.deleteProperty("X-MOZ-SEND-INVITATIONS");
    else item.setProperty("X-MOZ-SEND-INVITATIONS", "TRUE");
  }

  // ── The helpers ───────────────────────────────────────────────────────

  const helpers = new Map(
    Object.entries({
      async probe() {
        return {
          version: Services.appinfo.version,
          defaultZone: cal.timezoneService.defaultTimezone?.tzid ?? null,
          zones: cal.timezoneService.timezoneIds.length,
          duplicateId: Ci.calIErrors.DUPLICATE_ID,
          readOnly: Ci.calIErrors.CAL_IS_READONLY,
        };
      },

      /** Is our provider type registered, and what are the registered calendars? Nothing of sync443Calendar is called. */
      async calendars() {
        return {
          registered: cal.manager.hasCalendarProvider("sync443"),
          calendars: cal.manager.getCalendars().map((c) => ({
            id: c.id,
            type: c.type,
            name: c.name,
            uri: c.uri?.spec ?? null,
            disabled: !!c.getProperty("disabled"),
            forceDisabled: !!c.getProperty("force-disabled"),
            readOnly: !!c.readOnly,
          })),
        };
      },

      async calendarInfo({ calendarId, properties }) {
        const c = calendarById(calendarId);
        const values = {};
        for (const name of properties) {
          const value = c.getProperty(name);
          values[name] = name === "itip.transport" ? (value ? { type: value.type, scheme: value.scheme } : null) : (value ?? null);
        }
        const support = c.supportsScheduling ? c.getSchedulingSupport() : null;
        return {
          type: c.type,
          name: c.name,
          uri: c.uri.spec,
          providerID: c.providerID ?? null,
          canRefresh: c.canRefresh,
          supportsScheduling: !!c.supportsScheduling,
          canNotify: support
            ? ["PUBLISH", "REQUEST", "REPLY", "ADD", "CANCEL", "REFRESH", "COUNTER", "DECLINECOUNTER"].map((m) => support.canNotify(m, null))
            : null,
          schedulingCalendar: !!cal.itip.isSchedulingCalendar(c),
          values,
          prefs: prefsUnder(`${REGISTRY}${calendarId}.`),
        };
      },

      async prefs({ prefix }) {
        return prefsUnder(prefix);
      },

      async setProperty({ calendarId, name, value }) {
        calendarById(calendarId).setProperty(name, value);
        return calendarById(calendarId).getProperty(name) ?? null;
      },

      /** A calendar of the user: Thunderbird's own storage type, with one event. */
      async createUserCalendar({ name }) {
        const c = cal.manager.createCalendar("storage", Services.io.newURI("moz-storage-calendar://"));
        c.name = name;
        cal.manager.registerCalendar(c);
        return c.id;
      },

      /**
       * A calendar that is not ours although it looks like it: Thunderbird's
       * storage type with our marks and an id of our form ("storage"), or our
       * type marked for another extension or not marked at all ("sync443").
       */
      async forge({ type, id, owner, mailbox, slot, name }) {
        const uri = type === "storage" ? "moz-storage-calendar://" : `sync443://${mailbox}/forged`;
        const c = cal.manager.createCalendar(type, Services.io.newURI(uri));
        c.id = id;
        c.name = name;
        const marks = { "sync443.owner": owner, "sync443.mailbox": mailbox, "sync443.slot": slot };
        for (const [key, value] of Object.entries(marks)) {
          if (value !== undefined && value !== null) Services.prefs.setStringPref(`${REGISTRY}${id}.${key}`, value);
        }
        if (type !== "storage") {
          Services.prefs.setBoolPref(`${REGISTRY}${id}.sync443.events`, true);
          Services.prefs.setBoolPref(`${REGISTRY}${id}.sync443.tasks`, true);
          Services.prefs.setStringPref(`${REGISTRY}${id}.sync443.email`, "mallory@example.com");
        }
        cal.manager.registerCalendar(c);
        return c.id;
      },

      async items({ calendarId }) {
        const list = await calendarById(calendarId).getItemsAsArray(ALL, 0, null, null);
        return list.map(plain).sort((a, b) => a.id.localeCompare(b.id));
      },

      async item({ calendarId, itemId }) {
        const item = await calendarById(calendarId).getItem(itemId);
        return item ? plain(item) : null;
      },

      /**
       * An item read, and changed, through the calendar object itself, as
       * the code of Thunderbird that holds that object does. (Looked up from
       * the calendar manager, a calendar of Thunderbird 140 takes an item id
       * as a narrow string: an id with a character above U+00FF finds
       * nothing there, in any calendar.)
       */
      async directItem({ calendarId, itemId }) {
        const item = await calendarById(calendarId).wrappedJSObject.getItem(itemId);
        return item ? plain(item) : null;
      },

      async directEdit({ calendarId, itemId, ops }) {
        const c = calendarById(calendarId).wrappedJSObject;
        const old = await c.getItem(itemId);
        const item = old.clone();
        for (const op of ops) apply(item, op);
        await c.modifyItem(item, old);
        return true;
      },

      /**
       * What Thunderbird's interface asks before it lets the user touch an
       * item (cal.acl, as its dialogs, views, clipboard and reminders call
       * it), for the item as the calendar gives it now, for a copy of it
       * taken by an earlier call of this helper (`held: true` keeps one, as
       * an open view keeps its items), and for one occurrence (`rid`).
       */
      async access({ calendarId, itemId, rid, hold }) {
        const c = calendarById(calendarId);
        const stored = await c.getItem(itemId);
        if (!stored) return null;
        const item = rid ? stored.recurrenceInfo.getOccurrenceFor(utc(rid)) : stored;
        const ask = (i) => ({ modify: cal.acl.userCanModifyItem(i), respond: cal.acl.userCanRespondToInvitation(i) });
        const key = `${calendarId}/${itemId}`;
        const earlier = heldItems.get(key);
        const now = ask(item);
        // Kept once asked about: the copy carries the answer's entry, as an item kept by a view does.
        if (hold) heldItems.set(key, item.clone());
        const invitation = c.supportsScheduling && c.getSchedulingSupport().isInvitation(item);
        return {
          ...now,
          held: earlier ? ask(earlier) : null,
          // As Thunderbird chooses between its editing dialog and its read-only summary (calendar-item-editing.js).
          dialog: cal.acl.isCalendarWritable(c) && !invitation && cal.acl.userCanModifyItem(item) ? "edit" : "summary",
          calendar: { writable: cal.acl.isCalendarWritable(c), add: cal.acl.userCanAddItemsToCalendar(c), remove: cal.acl.userCanDeleteItemsFromCalendar(c), entry: c.aclEntry ? "set" : "none" },
          invitation,
        };
      },

      /** The occurrences Thunderbird itself computes between two UTC instants. */
      async occurrences({ calendarId, itemId, from, to }) {
        const item = await calendarById(calendarId).getItem(itemId);
        return item.getOccurrencesBetween(utc(from), utc(to)).map((o) => ({ title: o.title, start: when(o.startDate ?? o.entryDate), end: when(o.endDate) }));
      },

      async userAdd({ calendarId, spec }) {
        const added = await calendarById(calendarId).addItem(make(spec));
        return added.id;
      },

      async userEdit({ calendarId, itemId, ops }) {
        const c = calendarById(calendarId);
        const old = await c.getItem(itemId);
        const item = old.clone();
        for (const op of ops) apply(item, op);
        await c.modifyItem(item, old);
        return true;
      },

      async userDelete({ calendarId, itemId }) {
        const c = calendarById(calendarId);
        await c.deleteItem(await c.getItem(itemId));
        return true;
      },

      /** As the interface does for "delete this occurrence": the series loses the date. */
      async userDeleteOccurrence({ calendarId, itemId, rid }) {
        const c = calendarById(calendarId);
        const old = await c.getItem(itemId);
        const item = old.clone();
        item.recurrenceInfo.removeOccurrenceAt(item.recurrenceInfo.getOccurrenceFor(utc(rid)).recurrenceId);
        await c.modifyItem(item, old);
        return true;
      },

      /** As the interface does for "edit this occurrence": the occurrence itself is modified. */
      async userEditOccurrence({ calendarId, itemId, rid, ops }) {
        const c = calendarById(calendarId);
        const series = await c.getItem(itemId);
        const old = series.recurrenceInfo.getOccurrenceFor(utc(rid));
        const occurrence = old.clone();
        for (const op of ops) apply(occurrence, op);
        await c.modifyItem(occurrence, old);
        return true;
      },

      async watch({ calendarId }) {
        const counts = { onStartBatch: 0, onEndBatch: 0, onLoad: 0, onAddItem: 0, onModifyItem: 0, onDeleteItem: 0, onError: 0 };
        const observer = { QueryInterface: ChromeUtils.generateQI(["calIObserver"]), onPropertyChanged() {}, onPropertyDeleting() {} };
        for (const name of Object.keys(counts)) observer[name] = () => counts[name]++;
        const old = watchers.get(calendarId);
        if (old) calendarById(calendarId).removeObserver(old.observer);
        calendarById(calendarId).addObserver(observer);
        watchers.set(calendarId, { observer, counts });
        return true;
      },

      /** The notifications counted since the last call. */
      async watched({ calendarId }) {
        const { counts } = watchers.get(calendarId);
        const copy = { ...counts };
        for (const name of Object.keys(counts)) counts[name] = 0;
        return copy;
      },

      /** A mail identity, so that Thunderbird has something to send scheduling mail with. */
      async createIdentity({ email }) {
        // On "Local Folders", made as Thunderbird's account wizard makes it.
        MailServices.accounts.createLocalMailAccount();
        const server = MailServices.accounts.localFoldersServer;
        const account = MailServices.accounts.accounts.find((a) => a.incomingServer?.key === server.key);
        const identity = MailServices.accounts.createIdentity();
        identity.email = email;
        identity.fullName = "Test";
        identity.valid = true;
        account.addIdentity(identity);
        return identity.key;
      },

      /**
       * Thunderbird's own sending path for one item: CalItipOutgoingMessage
       * with a transport that counts, then cal.itip.checkAndSend as the
       * interface calls it after an addition, a change and a deletion, with
       * every mail transport replaced by a counter.
       */
      async scheduling({ calendarId, itemId, changed }) {
        const { CalItipOutgoingMessage } = ChromeUtils.importESModule("resource:///modules/CalItipOutgoingMessage.sys.mjs");
        const c = calendarById(calendarId);
        const item = await c.getItem(itemId);
        const out = { direct: {}, transportCalls: 0, checkAndSend: 0, returned: {} };
        const spy = spyTransport();
        for (const method of ["REQUEST", "CANCEL", "REPLY", "ADD", "REFRESH", "COUNTER", "DECLINECOUNTER", "PUBLISH"]) {
          const recipients = item.getAttendees();
          out.returned[method] = !!new CalItipOutgoingMessage(method, recipients, item, recipients[0] ?? null, { mode: Ci.calIItipItem.AUTO }).send(spy);
        }
        out.transportCalls = spy.calls;
        const restore = watchSending(c);
        try {
          const response = { responseMode: Ci.calIItipItem.AUTO };
          // As when the user leaves "notify attendees" checked: Thunderbird then means to send.
          const marked = item.clone();
          marked.setProperty("X-MOZ-SEND-INVITATIONS", "TRUE");
          cal.itip.checkAndSend(Ci.calIOperationListener.ADD, marked, null, response);
          const edited = marked.clone();
          for (const op of changed ?? [{ shift: 60 }, { location: "Ailleurs" }]) apply(edited, op);
          cal.itip.checkAndSend(Ci.calIOperationListener.MODIFY, edited, marked, response);
          cal.itip.checkAndSend(Ci.calIOperationListener.DELETE, marked, marked, response);
          out.checkAndSend = sent.calls;
        } finally {
          restore();
        }
        return out;
      },

      /** Rows of one calendar in our store, read through a connection of our own. */
      async storeRows({ calendarId }) {
        const file = cal.provider.getCalendarDirectory();
        file.append("sync443.sqlite");
        if (!file.exists()) return null;
        const db = Services.storage.openDatabase(file);
        const out = {};
        try {
          for (const table of ["cal_events", "cal_todos", "cal_metadata", "cal_attendees", "cal_properties", "cal_recurrence", "cal_alarms"]) {
            const statement = db.createStatement(`SELECT COUNT(*) AS n FROM ${table} WHERE cal_id = :id`);
            try {
              statement.params.id = calendarId;
              statement.executeStep();
              out[table] = statement.row.n;
            } finally {
              statement.finalize();
            }
          }
        } finally {
          db.close();
        }
        return out;
      },

      async watchAllSending() {
        watchAllSending();
        return session.smtp.watched;
      },

      /** What was handed to a mail transport of Thunderbird, and what reached its SMTP code, since watchAllSending(). */
      async sendingSeen() {
        return { watching: session.watching, transports: session.transports.map((t) => ({ ...t })), smtp: { ...session.smtp, watched: [...session.smtp.watched] } };
      },

      /**
       * Control of the SMTP watch: Thunderbird's own "verify the logon" of
       * the first outgoing server of the profile (for our accounts, a server
       * nothing listens on), which opens a connection as a sending would.
       * → the connections counted before and after, and whether it failed.
       */
      async smtpControl() {
        const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        const service = MailServices.outgoingServer ?? MailServices.smtp;
        const server = [...service.servers][0]?.QueryInterface(Ci.nsISmtpServer);
        if (!server) return { server: false };
        const before = session.smtp.connects;
        const status = await new Promise((resolve) => {
          const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
            OnStartRunningUrl() {},
            OnStopRunningUrl(url, code) {
              resolve(code);
            },
          };
          setTimeout(() => resolve(null), 15000);
          try {
            server.verifyLogon(listener, null);
          } catch (e) {
            resolve(`thrown: ${e?.name ?? e}`);
          }
        });
        return { server: true, hostname: server.hostname, port: server.port, before, after: session.smtp.connects, failed: status !== 0 && status !== null, status: typeof status === "number" ? status : String(status) };
      },

      /** Messages waiting in Thunderbird's own queue ("Unsent Messages"), in any account; read without creating anything. */
      async unsentMessages() {
        let queued = 0;
        let folders = 0;
        for (const server of MailServices.accounts.allServers) {
          let outbox = null;
          try {
            outbox = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Queue);
          } catch {
            outbox = null;
          }
          if (!outbox) continue;
          folders++;
          queued += outbox.getTotalMessages(false);
        }
        return { folders, queued };
      },

      /** Names of the preferences whose name or text value contains `text`. */
      async prefsMentioning({ text }) {
        const out = [];
        for (const name of Services.prefs.getChildList("")) {
          let value = "";
          if (Services.prefs.getPrefType(name) === Ci.nsIPrefBranch.PREF_STRING) {
            try {
              value = Services.prefs.getStringPref(name, "");
            } catch {
              value = "";
            }
          }
          if (name.includes(text) || value.includes(text)) out.push(name);
        }
        return out.sort();
      },

      async uiAdd({ calendarId, spec, notify, mode }) {
        const c = calendarById(calendarId);
        const item = make(spec);
        item.calendar = c;
        markNotify(item, c, notify === true);
        return (await transact("CalAddTransaction", item, c, null, mode)).id;
      },

      async uiEdit({ calendarId, itemId, ops, notify, mode }) {
        const c = calendarById(calendarId);
        const old = await c.getItem(itemId);
        const item = old.clone();
        for (const op of ops) apply(item, op);
        markNotify(item, c, notify === true);
        await transact("CalModifyTransaction", item, c, old, mode);
        return true;
      },

      async uiDelete({ calendarId, itemId, mode }) {
        const c = calendarById(calendarId);
        const item = await c.getItem(itemId);
        await transact("CalDeleteTransaction", item, c, null, mode);
        return true;
      },

      /** "Undo" of Thunderbird's Edit menu: the last transaction is taken back. */
      async uiUndo() {
        const transactions = ChromeUtils.importESModule("resource:///modules/CalTransactionManager.sys.mjs");
        await transactions.CalTransactionManager.getInstance().undo();
        return true;
      },

      /** "Delete this occurrence", as the views do it: the series without that date replaces the series. */
      async uiDeleteOccurrence({ calendarId, itemId, rid }) {
        const c = calendarById(calendarId);
        const old = await c.getItem(itemId);
        const item = old.clone();
        item.recurrenceInfo.removeOccurrenceAt(item.recurrenceInfo.getOccurrenceFor(utc(rid)).recurrenceId);
        await transact("CalModifyTransaction", item, c, old);
        return true;
      },

      /** "Edit this occurrence": the occurrence replaces the one the series gave. */
      async uiEditOccurrence({ calendarId, itemId, rid, ops }) {
        const c = calendarById(calendarId);
        const series = await c.getItem(itemId);
        const old = series.recurrenceInfo.getOccurrenceFor(utc(rid));
        const occurrence = old.clone();
        for (const op of ops) apply(occurrence, op);
        await transact("CalModifyTransaction", occurrence, c, old);
        return true;
      },

      /**
       * The user's answer to an invitation, given as the invitation bar of
       * its message gives it: Thunderbird's own iTIP processing
       * (cal.itip.processItipItem) of the calendar part of the mail, then the
       * action its Accept, Tentative and Decline buttons run. The two
       * dialogs the bar may show first (which calendar, which identity) are
       * not shown: the calendar is given.
       */
      async itipAnswer({ calendarId, ics, partstat, sender, identity, mode }) {
        const { CalItipItem } = ChromeUtils.importESModule("resource:///modules/CalItipItem.sys.mjs");
        const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        const c = calendarById(calendarId);
        watchTransportOf(c);
        const itipItem = new CalItipItem();
        itipItem.init(ics);
        itipItem.sender = sender ?? null;
        itipItem.identity = identity ?? null;
        itipItem.isSend = false;
        itipItem.autoResponse = Ci.calIItipItem.USER;
        itipItem.targetCalendar = c;
        const late = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
        try {
          const offered = await Promise.race([
            new Promise((resolve) => cal.itip.processItipItem(itipItem, (item, rc, actionFunc, foundItems) => resolve({ rc, actionFunc, found: foundItems?.length ?? 0 }))),
            late(15000, null),
          ]);
          if (!offered) return { offered: false };
          const out = { offered: true, rc: offered.rc, method: offered.actionFunc?.method ?? null, found: offered.found, received: itipItem.receivedMethod };
          if (!offered.actionFunc) return out;
          const done = await Promise.race([
            new Promise((resolve) => {
              const listener = {
                QueryInterface: ChromeUtils.generateQI(["calIOperationListener"]),
                onOperationComplete(calendar, status, type, id) {
                  resolve({ status, type, id: typeof id === "string" ? id : null });
                },
                onGetResult() {},
              };
              offered.actionFunc(listener, partstat, responseOf(mode));
            }),
            late(15000, { timeout: true }),
          ]);
          return { ...out, ...done, ok: done.timeout !== true && Components.isSuccessCode(done.status) };
        } finally {
          cal.itip.cleanupItipItem(itipItem);
        }
      },

      /**
       * The calendars of the main window: those its views use (the composite
       * calendar) with the items those views would be given, and the rows of
       * its calendar list as they are drawn.
       */
      async windowCalendars() {
        const win = Services.wm.getMostRecentWindow("mail:3pane");
        if (!win) return null;
        const composite = cal.view.getCompositeCalendar(win);
        const items = await composite.getItemsAsArray(ALL, 0, null, null);
        const counts = {};
        for (const item of items) counts[item.calendar.id] = (counts[item.calendar.id] ?? 0) + 1;
        const rows = {};
        for (const c of cal.manager.getCalendars()) {
          const row = win.document.getElementById(`calendar-listitem-${c.id}`);
          rows[c.id] = row
            ? { disabled: row.hasAttribute("calendar-disabled"), failed: row.hasAttribute("calendar-readfailed"), readOnly: row.hasAttribute("calendar-readonly"), name: row.querySelector(".calendar-name")?.textContent ?? null }
            : null;
        }
        return {
          componentLoaded: win.loadCalendarComponent?.hasBeenCalled === true,
          calendars: composite.getCalendars().map((c) => ({ id: c.id, type: c.type, disabled: !!c.getProperty("disabled"), ready: c.getProperty("force-disabled") !== true })),
          defaultId: composite.defaultCalendar?.id ?? null,
          items: counts,
          rows,
        };
      },

      /**
       * What the user chooses in the calendar list of the main window: a
       * calendar shown or hidden (its check box), and the calendar new items
       * go to (the selected one).
       */
      async windowChoose({ calendarId, shown, isDefault }) {
        const win = Services.wm.getMostRecentWindow("mail:3pane");
        const composite = cal.view.getCompositeCalendar(win);
        const c = calendarById(calendarId);
        if (shown === true) composite.addCalendar(c);
        if (shown === false) composite.removeCalendar(c);
        if (isDefault === true) composite.defaultCalendar = c;
        return { shown: composite.getCalendars().some((x) => x.id === calendarId), defaultId: composite.defaultCalendar?.id ?? null };
      },

      /**
       * Thunderbird's own import of a calendar file, from the items on
       * (CalendarFileImporter.startImport: what its import dialog runs once
       * the file is read). → how many were imported, and the result code of
       * the failure that stopped it, if any.
       */
      async importItems({ calendarId, specs }) {
        const { CalendarFileImporter } = ChromeUtils.importESModule("resource:///modules/CalendarFileImporter.sys.mjs");
        const importer = new CalendarFileImporter();
        let imported = 0;
        importer.onProgress = (current) => (imported = current);
        try {
          await importer.startImport(specs.map(make), calendarById(calendarId));
          return { imported, failed: null };
        } catch (e) {
          return { imported, failed: typeof e?.result === "number" ? e.result : String(e) };
        }
      },

      /**
       * A change made by code that leaves another calendar on the item it
       * hands over (`foreignId`), on the series or on one occurrence
       * (`rid`). → the calendar of the item the call returns, of the one the
       * observers are told, and of what the calendar then gives back.
       */
      async userEditAs({ calendarId, itemId, ops, foreignId, rid }) {
        const c = calendarById(calendarId);
        const foreign = calendarById(foreignId);
        const series = await c.getItem(itemId);
        const old = rid ? series.recurrenceInfo.getOccurrenceFor(utc(rid)) : series;
        const item = old.clone();
        for (const op of ops) apply(item, op);
        item.calendar = foreign;
        let told = null;
        const observer = { QueryInterface: ChromeUtils.generateQI(["calIObserver"]), onStartBatch() {}, onEndBatch() {}, onLoad() {}, onAddItem() {}, onDeleteItem() {}, onError() {},
          onPropertyChanged() {}, onPropertyDeleting() {}, onModifyItem: (changed) => (told = changed) };
        c.addObserver(observer);
        let returned = null;
        try {
          returned = await c.modifyItem(item, old);
        } finally {
          c.removeObserver(observer);
        }
        const stored = (await c.getItemsAsArray(ALL, 0, null, null)).find((i) => i.id === itemId);
        const calendarsOf = (i) => (i ? [i.calendar?.id ?? null, ...(i.recurrenceInfo?.getExceptionIds() ?? []).map((id) => i.recurrenceInfo.getExceptionFor(id).calendar?.id ?? null)] : null);
        return { returned: calendarsOf(returned?.parentItem), told: calendarsOf(told?.parentItem), stored: calendarsOf(stored) };
      },

      /**
       * An item of another calendar copied into this one as Thunderbird's
       * interface moves it: a copy on which the new calendar is set, then
       * added (the occurrences it changed keep the calendar they came from).
       * → the calendars of what this calendar then gives back.
       */
      async copyIn({ calendarId, fromId, itemId }) {
        const c = calendarById(calendarId);
        const item = (await calendarById(fromId).getItem(itemId)).clone();
        item.calendar = c;
        await c.addItem(item);
        const stored = (await c.getItemsAsArray(ALL, 0, null, null)).find((i) => i.id === itemId);
        return stored ? [stored.calendar?.id ?? null, ...stored.recurrenceInfo.getExceptionIds().map((id) => stored.recurrenceInfo.getExceptionFor(id).calendar?.id ?? null)] : null;
      },

      /**
       * What a view of Thunderbird asks a calendar for: every occurrence
       * between two instants. → how many there are, or the error: one item
       * Thunderbird cannot expand makes the whole request fail.
       */
      async viewItems({ calendarId, from, to }) {
        try {
          const list = await calendarById(calendarId).getItemsAsArray(ALL | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES, 0, utc(from), utc(to));
          return { count: list.length, error: null };
        } catch (e) {
          return { count: null, error: String(e?.message ?? e) };
        }
      },

      /**
       * Counts the occurrences Thunderbird builds from a series
       * (CalEvent.createProxy) between `on: true` and `on: false`. → the
       * count, when it is switched off.
       */
      async countProxies({ on }) {
        const proto = CalEvent.prototype;
        if (on && !faults.proxies) {
          const original = proto.createProxy;
          faults.proxies = { original, count: 0 };
          proto.createProxy = function (...args) {
            faults.proxies.count++;
            return original.apply(this, args);
          };
          return 0;
        }
        if (!on && faults.proxies) {
          const { original, count } = faults.proxies;
          proto.createProxy = original;
          faults.proxies = null;
          return count;
        }
        return 0;
      },

      /**
       * Fault: Thunderbird's storage no longer inserts the metadata rows of
       * this calendar (it deletes the old row, then the insertion is lost
       * without an error, as when its own statement fails and is only
       * logged). `on: false` puts its code back.
       */
      async failJournalInserts({ calendarId, on }) {
        const model = innerStore(calendarId).mMetaModel;
        if (on && !faults.inserts.has(calendarId)) {
          faults.inserts.set(calendarId, Object.hasOwn(model, "addMetaData") ? model.addMetaData : undefined);
          model.addMetaData = () => {};
        } else if (!on && faults.inserts.has(calendarId)) {
          const own = faults.inserts.get(calendarId);
          faults.inserts.delete(calendarId);
          if (own === undefined) delete model.addMetaData;
          else model.addMetaData = own;
        }
        return typeof model.addMetaData === "function";
      },

      /**
       * Fault: Thunderbird fails to expand any rule whose interval is
       * `interval` (a plain Error, as its recurrence code throws for a rule
       * it cannot follow). `on: false` puts its code back.
       */
      async failExpansion({ on, interval }) {
        const { CalRecurrenceRule } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceRule.sys.mjs");
        const proto = CalRecurrenceRule.prototype;
        if (on && !faults.expansion) {
          const original = proto.getOccurrences;
          faults.expansion = original;
          proto.getOccurrences = function (...args) {
            if (this.interval === interval) throw new Error("No possible occurrences");
            return original.apply(this, args);
          };
        } else if (!on && faults.expansion) {
          proto.getOccurrences = faults.expansion;
          faults.expansion = null;
        }
        return true;
      },

      /** Fault: the directory of the calendar databases cannot be had (a calendar of ours then gets no store). */
      async failStore({ on }) {
        if (on && !faults.directory) {
          faults.directory = cal.provider.getCalendarDirectory;
          cal.provider.getCalendarDirectory = () => {
            throw new Error("no directory");
          };
        } else if (!on && faults.directory) {
          cal.provider.getCalendarDirectory = faults.directory;
          faults.directory = null;
        }
        return true;
      },

      /**
       * A calendar leaves Thunderbird's list without its data being
       * deleted, as when the user removes the disabled stand-in of one of
       * our calendars while the extension is off: its rows stay in the store.
       */
      async unsubscribe({ calendarId }) {
        cal.manager.unregisterCalendar(calendarById(calendarId));
        return !cal.manager.getCalendars().some((c) => c.id === calendarId);
      },

      /**
       * `count` journal rows written straight into the store for a calendar
       * whose journal was not read yet: items the calendar would hold for
       * the collection, ServerIds `<prefix>0` … (no item behind them).
       */
      async fillJournal({ calendarId, collectionId, prefix, count }) {
        const db = ownConnection();
        try {
          db.executeSimpleSQL("BEGIN");
          const statement = db.createStatement("INSERT INTO cal_metadata (cal_id, item_id, value) VALUES (:cal_id, :item_id, :value)");
          try {
            for (let k = 0; k < count; k++) {
              const token = k.toString(16).padStart(32, "0");
              const head = { v: 1, n: token, i: `fill-${k}`, k: "event", u: null, s: `${prefix}${k}`, c: collectionId, h: null, p: null, r: 0, t: 0, o: null, f: 0, x: false, q: 0, w: false, a: null, g: 0 };
              statement.params.cal_id = calendarId;
              statement.params.item_id = `sync443:${token}`;
              statement.params.value = `${JSON.stringify(head)}\n`;
              statement.execute();
              statement.reset();
            }
          } finally {
            statement.finalize();
          }
          db.executeSimpleSQL("COMMIT");
        } finally {
          db.close();
        }
        return true;
      },

      /** The title of an event as it is in the store's file, read through a connection of our own. */
      async storedTitle({ calendarId, itemId }) {
        const db = ownConnection();
        try {
          const statement = db.createStatement("SELECT title FROM cal_events WHERE cal_id = :cal_id AND id = :id");
          try {
            statement.params.cal_id = calendarId;
            statement.params.id = itemId;
            return statement.executeStep() ? statement.row.title : null;
          } finally {
            statement.finalize();
          }
        } finally {
          db.close();
        }
      },

      /**
       * The extension stops while Thunderbird goes on (disabled, updated or
       * removed): sync443Calendar is told to shut down as Thunderbird tells
       * it, while a calendar object and one of its items are still held, as
       * an open event dialog or the undo list hold them. → what each write
       * through that object then does. Nothing of sync443Calendar works
       * after this call: the last step of a phase.
       */
      async shutdownWhileHeld({ calendarId, itemId }) {
        const held = calendarById(calendarId);
        const item = await held.getItem(itemId);
        // The object of sync443Calendar that serves this extension, and what Thunderbird calls on it when the extension stops.
        const api = extensionOfTest.apiManager.getAPI("sync443Calendar", extensionOfTest, "addon_parent");
        api.onShutdown(false);
        const outcome = async (write) => {
          try {
            await write();
            return "done";
          } catch (e) {
            return `refused${typeof e?.result === "number" ? ` 0x${(e.result >>> 0).toString(16)}` : ""}`;
          }
        };
        const edited = item.clone();
        edited.title = "written after the shutdown";
        const fresh = make({ id: "added-after-shutdown", start: "20280301T100000", end: "20280301T110000" });
        return {
          providerRegistered: cal.manager.hasCalendarProvider("sync443"),
          modify: await outcome(() => held.modifyItem(edited, item)),
          add: await outcome(() => held.addItem(fresh)),
          remove: await outcome(() => held.deleteItem(item)),
          stillRead: (await held.getItem(itemId))?.title ?? null,
        };
      },

      /**
       * What Thunderbird's storage does with its offline flag on a recurring
       * item (in a storage calendar of the user): is an item flagged as
       * deleted still listed during the same session?
       */
      async offlineFlagProbe({ calendarId }) {
        const c = calendarById(calendarId);
        const offline = c.QueryInterface(Ci.calIOfflineStorage);
        const seen = async (id) => (await c.getItemsAsArray(ALL, 0, null, null)).some((i) => i.id === id);
        const out = {};
        for (const [name, recurring] of [["single", false], ["recurring", true]]) {
          const item = make({ start: "20280105T100000", end: "20280105T110000", ops: recurring ? [{ rrule: "FREQ=DAILY;COUNT=3" }] : [] });
          item.id = `offline-flag-probe-${name}`;
          const added = await c.addItem(item);
          await seen(added.id);
          await offline.deleteOfflineItem(added);
          out[name] = await seen(added.id);
          await offline.resetItemOfflineFlag(added);
          await c.deleteItem(await c.getItem(added.id));
        }
        return out;
      },
    }),
  );

  let extensionOfTest = null;

  return class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      extensionOfTest = context.extension;
      return {
        sync443CalendarTest: {
          print,

          async quit() {
            await queue;
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
          },

          /** The phase the runner asked for (<profile>/sync443calendar-phase.json). */
          async phase() {
            const text = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, PHASE));
            return JSON.parse(text).phase;
          },

          async run(name, args) {
            const helper = helpers.get(name);
            if (!helper) throw new ExtensionError(`no helper ${name}`);
            try {
              return await helper(args ?? {});
            } catch (e) {
              throw new ExtensionError(`helper ${name}: ${e?.message ?? e} [${e?.result ?? ""}] ${String(e?.stack ?? "").split("\n").slice(0, 3).join(" | ")}`);
            }
          },
        },
      };
    }
  };
})();
