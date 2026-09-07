"use strict";

const API = 'https://hacker-news.firebaseio.com/v0';
const HN  = 'https://news.ycombinator.com';

const SITES_KEY  = 'hn_blocked_sites';
const USERS_KEY  = 'hn_blocked_users';
const POSTS_KEY  = 'hn_blocked_posts';
const SAVED_KEY  = 'hn_saved';
const SETTINGS_KEY = 'hn_settings';
const SCHEMA_KEY = 'hn_schema';
const TAB_KEY    = 'hn_tab';

const SCHEMA_VERSION = 1;   // storage schema, shared by the lists and the UI state
const EXPORT_VERSION = 3;   // 2 added the saved list, 3 adds the blocked posts
const EXPORT_READS   = [1, 2, 3];   // an older file simply has fewer sections
const STORY_COUNT    = 500;
const NARROW = window.matchMedia('(max-width: 640px)');

const TAB_LABEL = { top: 'top', new: 'newest' };
const FEED_TABS = ['top', 'new'];   // Saved is a local list and never fetches

let currentTab = 'top';
let stories = { top: [], new: [] };
let showBlocked = false;

/* ============================================================
   STORAGE CORE
   Every mutation re-reads the live value first, so a tab that has
   been open for hours can never write a stale snapshot over blocks
   made somewhere else. Nothing is ever held in a module-level cache.
   ============================================================ */

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[hn] could not read ' + key, err);
    toast('Could not read saved list (' + key + ')', true);
    return [];
  }
}

function writeList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch (err) {
    console.error('[hn] could not save ' + key, err);
    toast('SAVE FAILED. This block was not stored. ' + (err && err.name === 'QuotaExceededError'
      ? 'Storage is full; export a backup and remove some entries.'
      : err.message), true);
    return false;
  }
}

// Read-modify-write against the current stored value.
function mutateList(key, fn) {
  const live = readList(key);
  const next = fn(live.slice());
  if (!Array.isArray(next)) return live;
  next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  writeList(key, next);
  return next;
}

/* ============================================================
   SETTINGS
   Per-device preferences, kept apart from the lists on purpose.
   They are not in the backup: import merges lists, and silently
   overwriting someone's preferences from a file is not a merge.
   ============================================================ */

const SETTING_DEFAULTS = {
  xcancel: false,         // open x.com and twitter.com story links through xcancel.com
  ytEmbed: false          // open YouTube story links as a bare nocookie embed
};

function readSettings() {
  let stored = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch (err) {
    console.error('[hn] could not read settings', err);
  }
  return Object.assign({}, SETTING_DEFAULTS, stored);
}

function getSetting(name) {
  return readSettings()[name];
}

function setSetting(name, value) {
  const next = readSettings();
  next[name] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch (err) {
    console.error('[hn] could not save settings', err);
    toast('That setting was not saved.', true);
    return;
  }
  renderStories();
}

function renderSettings() {
  const current = readSettings();
  document.querySelectorAll('#settingsPanel input[data-setting]').forEach(input => {
    input.checked = !!current[input.getAttribute('data-setting')];
  });
}

/* The rewrite happens when a link is drawn, never when a story is stored, so
   the saved list keeps the canonical URL and turning the setting off puts every
   link back where it was. */
const XCANCEL_FOR = ['x.com', 'twitter.com'];
const YOUTUBE_FOR = ['youtube.com', 'youtu.be'];
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function xcancelUrl(u) {
  if (!XCANCEL_FOR.some(host => hostMatches(u.hostname, host))) return null;
  u.protocol = 'https:';
  u.hostname = 'xcancel.com';
  return u.toString();
}

// "90", "90s", "1h2m3s" and "2m30s" all appear in the wild.
function startSeconds(value) {
  if (!value) return 0;
  const plain = /^\d+s?$/.exec(value);
  if (plain) return parseInt(value, 10);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!parts || !parts[0]) return 0;
  return (+(parts[1] || 0)) * 3600 + (+(parts[2] || 0)) * 60 + (+(parts[3] || 0));
}

/* Returns null unless a single video can be identified with certainty. A
   playlist, a channel or a search has nothing to embed, and a link that cannot
   be parsed is left exactly as it was rather than guessed at. */
function youtubeRef(raw) {
  let u;
  try { u = new URL(raw); } catch (err) { return null; }
  if (!YOUTUBE_FOR.some(host => hostMatches(u.hostname, host))) return null;

  let id = null;
  if (hostMatches(u.hostname, 'youtu.be')) {
    id = u.pathname.split('/')[1];
  } else {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg[0] === 'watch') id = u.searchParams.get('v');
    else if (seg[0] === 'shorts' || seg[0] === 'live' || seg[0] === 'embed') id = seg[1];
  }
  if (!id || !VIDEO_ID.test(id)) return null;

  return { id: id, start: startSeconds(u.searchParams.get('t') || u.searchParams.get('start')) };
}

/* The href points at this app's own watch page, not straight at the embed:
   YouTube refuses an embed loaded as a top level navigation (Error 153), so the
   player needs a page on this origin to sit inside. In the app a click is
   intercepted and the same player opens as a layer instead, because a
   same-origin, in-scope navigation replaces the installed app's own window and
   coming back reloads it, losing the loaded stories and the filter. The href
   stays real so opening the link in a new tab still works. */
function watchPageUrl(ref) {
  return 'watch.html?v=' + ref.id + (ref.start ? '&t=' + ref.start : '');
}

function linkUrl(s) {
  const raw = s.url || s.hnLink;
  let u;
  try { u = new URL(raw); } catch (err) { return raw; }

  if (getSetting('xcancel')) {
    const swapped = xcancelUrl(new URL(raw));
    if (swapped) return swapped;
  }
  if (getSetting('ytEmbed')) {
    const ref = youtubeRef(raw);
    if (ref) return watchPageUrl(ref);
  }
  return raw;
}

// The video ref for a story, or null when nothing should be intercepted.
function videoRef(s) {
  const on = renderPass ? renderPass.ytEmbed : getSetting('ytEmbed');
  if (!on) return null;
  return youtubeRef(s.url || s.hnLink);
}

/* ============================================================
   SAVED STORIES
   A read-later list, kept in the order it was built with the most
   recent first. It holds everything a story row shows except the
   score, because a story falls out of the top 500 within a day or
   two and an id on its own would go dead.

   Deliberately outside the undo stack: a saved story is removed by
   its own delete button, one row at a time, and there is nothing to
   reverse in bulk.
   ============================================================ */

function readSaved() {
  return readList(SAVED_KEY);
}

// Like mutateList, but without the sort by name: these lists are ordered by
// when things were added, and their entries have an id rather than a name.
function mutateUnsorted(key, fn) {
  const next = fn(readList(key).slice());
  if (!Array.isArray(next)) return readList(key);
  writeList(key, next);
  return next;
}

function mutateSaved(fn) {
  return mutateUnsorted(SAVED_KEY, fn);
}

function isSaved(id) {
  const key = String(id);
  if (renderPass) return renderPass.saved.has(key);
  return readSaved().some(s => String(s.id) === key);
}

function savedFromStory(s) {
  return {
    id: s.id,
    title: s.title || '',
    url: s.url || '',
    domain: s.domain || null,
    user: s.user || '',
    comments: s.comments || 0,
    time: s.time || 0,
    hnLink: s.hnLink,
    savedAt: Date.now()
  };
}

function saveStory(id) {
  const key = String(id);
  const story = (stories[currentTab] || []).find(s => String(s.id) === key);
  if (!story) return;
  if (isSaved(key)) { toast('Already saved.'); return; }
  mutateSaved(list => [savedFromStory(story)].concat(list));
  renderStories();
  updateCounts();
  toast('Saved.');
}

function unsaveStory(id) {
  const key = String(id);
  mutateSaved(list => list.filter(s => String(s.id) !== key));
  renderStories();
  updateCounts();
}

/* ============================================================
   UNDO
   One global, chronological stack, held in memory only and reset on
   launch. Every blocklist change pushes its own inverse before it
   writes, so undo is "reverse the last thing I did" regardless of
   which list it touched or which screen it was done from.
   ============================================================ */

const undoStack = [];

function pushUndo(entry) {
  undoStack.push(entry);
  updateUndoButtons();
}

function updateUndoButtons() {
  const enabled = undoStack.length > 0 && !confirmPending();
  document.querySelectorAll('#undoBtn, .panel-tools button[data-act="undo"]').forEach(b => {
    b.disabled = !enabled;
  });
}

function performUndo() {
  const entry = undoStack[undoStack.length - 1];
  if (!entry) { toast('Nothing to undo.'); return; }
  if (entry.kind === 'import') { askImportUndo(entry); return; }
  applyUndo(entry);
}

function applyUndo(entry) {
  const i = undoStack.lastIndexOf(entry);
  if (i === -1) return;
  undoStack.splice(i, 1);
  entry.undo();
  refreshAllViews();
  updateUndoButtons();
  toast('Undone: ' + entry.label);
}

/* Undoing an import is the one destructive undo, so it asks first (D37).
   While it is pending the stack is frozen: blocking is refused rather than
   allowed to reorder it under the question being asked (D48). The state is
   cleared on every exit from the confirm, not only on confirm and cancel. */

let confirmState = null;

function confirmPending() { return confirmState !== null; }

function askImportUndo(entry) {
  if (confirmPending()) return;
  confirmState = { entry: entry, timer: null };
  updateUndoButtons();
  confirmState.timer = setTimeout(() => endConfirm(), 60000);
  showConfirmToast('Undo the import?', () => {
    const pending = confirmState && confirmState.entry;
    endConfirm();
    if (pending) applyUndo(pending);
  }, () => {
    endConfirm();
  });
}

function endConfirm() {
  if (!confirmState) return;
  clearTimeout(confirmState.timer);
  confirmState = null;
  hideConfirmToast();
  updateUndoButtons();
}

// Every path that can change a blocklist checks this first.
function blockingFrozen() {
  if (!confirmPending()) return false;
  toast('Answer the pending undo first, then block.', true);
  return true;
}

/* ============================================================
   HOSTNAME NORMALISATION
   Old behaviour stored "www.reuters.com" and matched it literally,
   so a later story on bare "reuters.com" slipped through. Everything
   is now stored stripped of "www." and matched on the base domain
   plus any subdomain of it.
   ============================================================ */

function normHost(input) {
  if (!input) return '';
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // tolerate a pasted URL
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/:\d+$/, '');                      // port
  d = d.replace(/^www\d*\./, '');                  // www. / www2.
  d = d.replace(/\.$/, '');                        // trailing dot
  return d;
}

function normUser(input) {
  return String(input || '').trim().toLowerCase();
}

/* A repost is the same link submitted again by someone else, so it arrives with
   a new item id. Keying a post block on the link is what catches it. Scheme,
   www., the fragment and the usual tracking parameters all vary between two
   submissions of the same article and none of them identify it, so they go. The
   remaining query is kept and sorted, because plenty of sites put the article
   id in there. */
const TRACKING_PARAMS = /^(utm_|ref$|ref_src$|fbclid$|gclid$|igshid$|mc_cid$|mc_eid$|si$|s$|cmpid$|smid$|_hsenc$|_hsmi$)/;

function normUrl(input) {
  if (!input) return '';
  let u;
  try { u = new URL(String(input)); } catch (err) { return ''; }
  const host = normHost(u.hostname);
  if (!host) return '';
  const keep = [];
  u.searchParams.forEach((value, name) => {
    if (!TRACKING_PARAMS.test(name.toLowerCase())) keep.push(name.toLowerCase() + '=' + value);
  });
  keep.sort();
  const path = u.pathname.replace(/\/+$/, '');
  return host + path + (keep.length ? '?' + keep.join('&') : '');
}

// Only ever compared for text posts, which have no link to key on.
function normTitle(input) {
  return String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
}


function hostMatches(host, blockedName) {
  const h = normHost(host);
  const b = normHost(blockedName);
  if (!h || !b) return false;
  return h === b || h.endsWith('.' + b);
}

/* One shared schema version for the blocklists and the UI state. A release
   that only changes one area leaves the other alone: its branch is a no-op.
   Version 1 is the first schema on the hosted origin, so there is nothing to
   convert; it only clears keys the file:// build left behind. */
function migrateStoredLists() {
  if (localStorage.getItem(SCHEMA_KEY) === String(SCHEMA_VERSION)) return;
  try {
    localStorage.removeItem('hn_blocked_schema');   // superseded by hn_schema
    localStorage.removeItem(SITES_KEY + '_prev');   // superseded by the undo stack
    localStorage.removeItem(USERS_KEY + '_prev');
    localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
  } catch (e) { /* a full or blocked store is not a reason to fail the launch */ }
}

/* ============================================================
   BLOCK / UNBLOCK
   The four functions below are the only writers of either list, so
   they are also the only place the undo stack is fed.
   ============================================================ */

function addBlockedSite(domain, title, user) {
  if (blockingFrozen()) return;
  const name = normHost(domain !== undefined && domain !== null && domain !== ''
    ? domain
    : document.getElementById('blockSiteInput').value);
  if (!name) return;
  let alreadyThere = false;
  mutateList(SITES_KEY, list => {
    if (list.some(s => normHost(s.name) === name)) { alreadyThere = true; return list; }
    list.push({ name, title: title || '', user: user || '', time: Date.now() });
    return list;
  });
  document.getElementById('blockSiteInput').value = '';
  if (alreadyThere) { toast(name + ' is already blocked.'); return; }
  pushUndo({
    label: 'blocked ' + name,
    undo: () => mutateList(SITES_KEY, l => l.filter(s => normHost(s.name) !== name))
  });
  refreshAllViews();
}

function removeBlockedSite(name) {
  if (blockingFrozen()) return;
  const n = normHost(name);
  let removed = [];
  mutateList(SITES_KEY, list => {
    removed = list.filter(s => normHost(s.name) === n);
    return list.filter(s => normHost(s.name) !== n);
  });
  if (removed.length) {
    pushUndo({
      label: 'unblocked ' + n,
      undo: () => mutateList(SITES_KEY, l =>
        l.filter(s => normHost(s.name) !== n).concat(removed))
    });
  }
  refreshAllViews();
}

function addBlockedUser(username, title, site) {
  if (blockingFrozen()) return;
  const name = normUser(username !== undefined && username !== null && username !== ''
    ? username
    : document.getElementById('blockUserInput').value);
  if (!name) return;
  let alreadyThere = false;
  mutateList(USERS_KEY, list => {
    if (list.some(u => normUser(u.name) === name)) { alreadyThere = true; return list; }
    list.push({ name, title: title || '', site: site || '', time: Date.now() });
    return list;
  });
  document.getElementById('blockUserInput').value = '';
  if (alreadyThere) { toast(name + ' is already blocked.'); return; }
  pushUndo({
    label: 'blocked ' + name,
    undo: () => mutateList(USERS_KEY, l => l.filter(u => normUser(u.name) !== name))
  });
  refreshAllViews();
}

/* Blocking a post keys on the link, not on the item, because HN re-promotes
   stories and other people repost the same link, and either way it comes back
   with a new id. A text post has no link, so those key on the title instead,
   which is safe there and would not be safe generally: two unrelated articles
   can share a headline, two unrelated Ask HN posts rarely do. The id is kept as
   well, so an entry made before this still works and so does a post with
   neither a usable link nor a title. */

function postKeys(s) {
  const url = normUrl(s.url);
  return {
    id: String(s.id),
    url: url,
    title: url ? '' : normTitle(s.title)   // titles only stand in for a missing link
  };
}

function postEntryMatches(entry, keys) {
  if (String(entry.id) === keys.id) return true;
  if (keys.url && entry.url === keys.url) return true;
  if (!keys.url && keys.title && entry.title === keys.title) return true;
  return false;
}

function findStory(id) {
  const key = String(id);
  return (stories[currentTab] || []).find(s => String(s.id) === key) || null;
}

function addBlockedPost(id) {
  if (blockingFrozen()) return;
  const story = findStory(id);
  if (!story) return;
  const keys = postKeys(story);
  let alreadyThere = false;
  mutateUnsorted(POSTS_KEY, list => {
    if (list.some(p => postEntryMatches(p, keys))) { alreadyThere = true; return list; }
    list.push({ id: keys.id, url: keys.url, title: keys.title, time: Date.now() });
    return list;
  });
  if (alreadyThere) return;
  pushUndo({
    label: 'blocked a post',
    undo: () => mutateUnsorted(POSTS_KEY, l => l.filter(p => !postEntryMatches(p, keys)))
  });
  refreshAllViews();
}

function removeBlockedPost(id) {
  if (blockingFrozen()) return;
  const story = findStory(id);
  if (!story) return;
  // Removes whatever entry matched, which for a repost is not the entry whose
  // id equals this story's.
  const keys = postKeys(story);
  let removed = [];
  mutateUnsorted(POSTS_KEY, list => {
    removed = list.filter(p => postEntryMatches(p, keys));
    return list.filter(p => !postEntryMatches(p, keys));
  });
  if (removed.length) {
    pushUndo({
      label: 'unblocked a post',
      undo: () => mutateUnsorted(POSTS_KEY, l =>
        l.filter(p => !postEntryMatches(p, keys)).concat(removed))
    });
  }
  refreshAllViews();
}

function removeBlockedUser(name) {
  if (blockingFrozen()) return;
  const n = normUser(name);
  let removed = [];
  mutateList(USERS_KEY, list => {
    removed = list.filter(u => normUser(u.name) === n);
    return list.filter(u => normUser(u.name) !== n);
  });
  if (removed.length) {
    pushUndo({
      label: 'unblocked ' + n,
      undo: () => mutateList(USERS_KEY, l =>
        l.filter(u => normUser(u.name) !== n).concat(removed))
    });
  }
  refreshAllViews();
}

/* ============================================================
   FILTERING
   ============================================================ */

function isSiteBlocked(domain) {
  if (!domain) return false;
  return readList(SITES_KEY).some(s => hostMatches(domain, s.name));
}

function isUserBlocked(user) {
  if (!user) return false;
  const u = normUser(user);
  return readList(USERS_KEY).some(x => normUser(x.name) === u);
}

function isPostBlocked(story) {
  const keys = postKeys(story);
  if (renderPass) {
    const p = renderPass.posts;
    return p.ids.has(keys.id)
      || (!!keys.url && p.urls.has(keys.url))
      || (!keys.url && !!keys.title && p.titles.has(keys.title));
  }
  return readList(POSTS_KEY).some(entry => postEntryMatches(entry, keys));
}

function isStoryBlocked(story) {
  return isPostBlocked(story) || isSiteBlocked(story.domain) || isUserBlocked(story.user);
}

/* ============================================================
   API
   ============================================================ */

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal: signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Bounded concurrency. 500 simultaneous requests used to drop items silently.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchStories(type, count, signal) {
  const endpoint = type === 'top' ? 'topstories.json' : 'newstories.json';
  const ids = await fetchJson(API + '/' + endpoint, signal);
  const items = await mapLimit(ids.slice(0, count), 12, id => fetchJson(API + '/item/' + id + '.json', signal));
  if (signal && signal.aborted) throw abortError();
  return items.filter(Boolean).map(item => {
    let domain = null;
    if (item.url) { try { domain = new URL(item.url).hostname; } catch (e) { domain = null; } }
    return {
      id: item.id,
      title: item.title || '',
      url: item.url || '',
      domain: domain,
      user: item.by || '',
      score: item.score || 0,
      comments: item.descendants || 0,
      time: (item.time || 0) * 1000,
      hnLink: HN + '/item?id=' + item.id
    };
  });
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/* ============================================================
   RENDERING (DOM built as nodes, so there is no string escaping to get wrong)
   ============================================================ */

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else if (k.startsWith('data-')) node.setAttribute(k, props[k]);
      else node[k] = props[k];
    }
  }
  (children || []).forEach(c => { if (c) node.appendChild(c); });
  return node;
}

function actionButton(label, title, action, payload) {
  const b = el('button', { text: label, title: title, type: 'button' });
  b.setAttribute('data-action', action);
  b.setAttribute('data-name', payload.name || '');
  b.setAttribute('data-title', payload.title || '');
  b.setAttribute('data-extra', payload.extra || '');
  return b;
}

// Title, domain and the author/time/comments line. Shared by the feed rows and
// the saved rows, which differ only in the score and the buttons.
function storyInfo(s) {
  const info = el('div', { class: 'info' });

  const titleLink = el('a', { href: linkUrl(s), target: '_blank', rel: 'noopener noreferrer', text: s.title });
  const video = videoRef(s);
  if (video) {
    titleLink.setAttribute('data-video', video.id);
    titleLink.setAttribute('data-start', String(video.start));
  }
  const titleRow = el('div', { class: 'title-row' }, [titleLink]);
  if (s.domain) {
    const wrap = el('span', { class: 'domain' });
    wrap.appendChild(document.createTextNode('('));
    wrap.appendChild(el('a', { href: 'https://' + s.domain, target: '_blank', rel: 'noopener noreferrer', text: s.domain }));
    wrap.appendChild(document.createTextNode(')'));
    titleRow.appendChild(wrap);
  }
  info.appendChild(titleRow);

  const meta = el('div', { class: 'meta' });
  if (s.user) {
    meta.appendChild(el('a', { href: HN + '/user?id=' + encodeURIComponent(s.user), target: '_blank', rel: 'noopener noreferrer', text: s.user }));
    meta.appendChild(document.createTextNode(' · '));
  }
  meta.appendChild(document.createTextNode(timeAgo(s.time) + ' · '));
  meta.appendChild(el('a', { href: s.hnLink, target: '_blank', rel: 'noopener noreferrer', text: s.comments + ' comments' }));
  info.appendChild(meta);

  return info;
}

function savedRow(item) {
  const actions = el('div', { class: 'actions' });
  const del = el('button', { text: 'delete', title: 'Remove ' + item.title + ' from Saved', type: 'button' });
  del.setAttribute('data-action', 'unsave-story');
  del.setAttribute('data-id', String(item.id));
  actions.appendChild(del);

  return el('div', { class: 'story saved-row' }, [storyInfo(item), actions]);
}

/* The row reads "Block post user site", then a gap, then save. One verb said
   once, so each button only has to name what it acts on. In Show Blocked the
   same shape reads "Unblock", carrying only the buttons that apply. */
function storyRow(s) {
  const info = storyInfo(s);
  const actions = el('div', { class: 'actions' });
  const group = el('div', { class: 'action-group' });

  if (showBlocked) {
    group.appendChild(el('span', { class: 'action-label', text: 'Unblock' }));
    if (isPostBlocked(s)) {
      const post = el('button', { text: 'post', title: 'Unblock this post', type: 'button' });
      post.setAttribute('data-action', 'unblock-post');
      post.setAttribute('data-id', String(s.id));
      group.appendChild(post);
    }
    if (isUserBlocked(s.user)) {
      group.appendChild(actionButton('user', 'Unblock ' + s.user, 'unblock-user', { name: s.user }));
    }
    if (isSiteBlocked(s.domain)) {
      const matched = matchingSiteRule(s.domain);
      group.appendChild(actionButton('site', 'Unblock ' + matched, 'unblock-site', { name: matched }));
    }
    actions.appendChild(group);
  } else {
    group.appendChild(el('span', { class: 'action-label', text: 'Block' }));
    const post = el('button', { text: 'post', title: 'Hide this post', type: 'button' });
    post.setAttribute('data-action', 'block-post');
    post.setAttribute('data-id', String(s.id));
    group.appendChild(post);
    if (s.user) group.appendChild(actionButton('user', 'Block ' + s.user, 'block-user', { name: s.user, title: s.title, extra: s.domain || 'self' }));
    if (s.domain) group.appendChild(actionButton('site', 'Block ' + normHost(s.domain) + ' and its subdomains', 'block-site', { name: s.domain, title: s.title, extra: s.user }));
    actions.appendChild(group);

    const saved = isSaved(s.id);
    const save = el('button', {
      text: saved ? 'saved' : 'save',
      title: saved ? 'Remove from Saved' : 'Save for later',
      type: 'button',
      class: saved ? 'muted' : ''
    });
    save.setAttribute('data-action', saved ? 'unsave-story' : 'save-story');
    save.setAttribute('data-id', String(s.id));
    actions.appendChild(save);
  }

  const row = el('div', { class: 'story' }, [
    el('div', { class: 'score', text: String(s.score) }),
    info,
    actions
  ]);
  row.setAttribute('data-id', String(s.id));   // how the saved pass finds it again
  return row;
}

// Which stored rule caused this domain to be hidden (so "unblock" removes the right one).
function matchingSiteRule(domain) {
  const hit = readList(SITES_KEY).find(s => hostMatches(domain, s.name));
  return hit ? normHost(hit.name) : normHost(domain);
}

function matchesQuery(s, query) {
  if (!query) return true;
  return (s.title + ' ' + (s.domain || '') + ' ' + s.user).toLowerCase().includes(query);
}

/* Reads hoisted out of the row loop for the length of one render. Every lookup
   below used to parse its key out of localStorage again for each of 500 rows.
   Never outlives the synchronous pass that sets it, so it cannot go stale. */
let renderPass = null;

function beginRenderPass() {
  renderPass = {
    saved: new Set(readSaved().map(s => String(s.id))),
    posts: (() => {
      const entries = readList(POSTS_KEY);
      return {
        ids: new Set(entries.map(p => String(p.id))),
        urls: new Set(entries.map(p => p.url).filter(Boolean)),
        titles: new Set(entries.map(p => p.title).filter(Boolean))
      };
    })(),
    ytEmbed: getSetting('ytEmbed')
  };
}

function endRenderPass() {
  renderPass = null;
}

function renderStories() {
  const container = document.getElementById('storyList');
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();

  if (currentTab === 'saved') {
    // Blocking does not filter this list. You saved these on purpose, and a
    // row that vanishes because you later blocked its site reads as data loss.
    for (const item of readSaved()) {
      if (!matchesQuery(item, query)) continue;
      frag.appendChild(savedRow(item));
    }
  } else {
    beginRenderPass();
    try {
      for (const s of stories[currentTab] || []) {
        const blocked = isStoryBlocked(s);
        if (showBlocked ? !blocked : blocked) continue;
        if (!matchesQuery(s, query)) continue;
        frag.appendChild(storyRow(s));
      }
    } finally {
      endRenderPass();
    }
  }

  container.innerHTML = '';
  container.appendChild(frag);
  scheduleSavedMarks();
}

/* The stripe is painted in a second pass, after the browser has had the rows on
   screen, so the list appears without waiting on it. It is a class toggle and
   an inset shadow, so it costs no layout and cannot move anything. */

let savedMarkFrame = null;

function scheduleSavedMarks() {
  if (savedMarkFrame !== null) cancelAnimationFrame(savedMarkFrame);
  savedMarkFrame = requestAnimationFrame(() => {
    savedMarkFrame = null;
    markSavedRows();
  });
}

function markSavedRows() {
  // Saved rows carry no data-id, so the Saved tab is skipped: striping every
  // row of a list that is entirely saved says nothing.
  const rows = document.querySelectorAll('#storyList .story[data-id]');
  if (!rows.length) return;
  const saved = new Set(readSaved().map(s => String(s.id)));
  rows.forEach(row => row.classList.toggle('is-saved', saved.has(row.getAttribute('data-id'))));
}

function renderBlockedList(containerId, key, action) {
  const container = document.getElementById(containerId);
  const list = readList(key);
  const frag = document.createDocumentFragment();
  list.forEach(item => {
    const info = el('div', { class: 'blocked-info' }, [
      el('span', { class: 'blocked-name', text: item.name })
    ]);
    if (item.title) {
      const secondary = key === SITES_KEY ? (item.user || '') : (item.site || 'self');
      info.appendChild(el('span', { class: 'blocked-meta', text: item.title + (secondary ? ' · ' + secondary : '') }));
    }
    const rm = el('button', { text: '×', title: 'Unblock ' + item.name, type: 'button' });
    rm.setAttribute('data-action', action);
    rm.setAttribute('data-name', item.name);
    frag.appendChild(el('div', { class: 'blocked-item' }, [info, rm]));
  });
  container.innerHTML = '';
  container.appendChild(frag);
}

function renderBlockedSites() {
  renderBlockedList('blockedSitesList', SITES_KEY, 'unblock-site');
  document.getElementById('sitesCount').textContent = plural(readList(SITES_KEY).length, 'site') + ' blocked';
}

function renderBlockedUsers() {
  renderBlockedList('blockedUsersList', USERS_KEY, 'unblock-user');
  document.getElementById('usersCount').textContent = plural(readList(USERS_KEY).length, 'user') + ' blocked';
}

function updateCounts() {
  const list = stories[currentTab] || [];
  const blockedCount = list.filter(isStoryBlocked).length;
  const visibleCount = list.length - blockedCount;

  if (currentTab === 'saved') {
    document.getElementById('storyCount').textContent = plural(readSaved().length, 'saved story', 'saved stories');
    document.getElementById('hiddenCount').textContent = '';
  } else if (showBlocked) {
    document.getElementById('storyCount').textContent = plural(blockedCount, 'blocked story', 'blocked stories');
    document.getElementById('hiddenCount').textContent = visibleCount + ' unblocked';
  } else {
    document.getElementById('storyCount').textContent = plural(visibleCount, 'story', 'stories');
    document.getElementById('hiddenCount').textContent = blockedCount + ' hidden';
  }
  const badge = document.getElementById('blockedBadge');
  if (badge) badge.textContent = blockedCount;
}

function refreshAllViews() {
  renderBlockedSites();
  renderBlockedUsers();
  renderStories();
  updateCounts();
}

function toggleBlockedView() {
  showBlocked = !showBlocked;
  document.body.classList.toggle('blocked-view', showBlocked);
  const btn = document.getElementById('viewToggleBtn');
  btn.innerHTML = showBlocked
    ? 'Show Stories'
    : 'Show Blocked <span class="badge" id="blockedBadge">0</span>';
  renderStories();
  updateCounts();
}

/* ============================================================
   THE FETCH CONTROLLER
   Three states, one pure transition function, one commit point.
   Nothing fetches on its own except the first load and a single
   retry when the connection comes back: every other fetch is a tap.

   "Failed" is a statement about the last request, not about the
   device. navigator.onLine reports link-layer connectivity and is
   wrong in both directions, so it guards nothing here; the online
   event is used once, as a trigger to leave Failed.
   ============================================================ */

const IDLE = 'Idle', FETCHING = 'Fetching', FAILED = 'Failed';
let fetchState = IDLE;

function fetchTransition(state, event) {
  switch (event) {
    case 'refresh':
    case 'switch-empty':
      return { next: FETCHING, abort: state === FETCHING, start: true };
    case 'switch-has':
      return { next: state };
    case 'online':
      return state === FAILED ? { next: FETCHING, start: true } : { next: state };
    case 'panel-open':
      return state === FETCHING ? { next: IDLE, abort: true } : { next: state };
    case 'landed':
      return state === FETCHING ? { next: IDLE, render: true } : { next: state };
    case 'failed-cold':
      return state === FETCHING ? { next: FAILED, coldMessage: true } : { next: state };
    case 'failed-warm':
      return state === FETCHING ? { next: IDLE, warmToast: true } : { next: state };
    default:
      return { next: state };
  }
}

function dispatchFetch(event, payload) {
  const p = payload || {};
  const t = fetchTransition(fetchState, event);
  fetchState = t.next;                      // the single place the state is written
  if (t.abort) abortFetch();
  if (t.start) startFetch(p.tab || currentTab);
  if (t.render) {
    fetchingTab = null;
    hideListMessage();
    // Progress belongs to the tab it is about. Landing while the reader is on
    // another tab is not news to them.
    if (p.tab === currentTab) {
      report('Loaded ' + plural((stories[p.tab] || []).length, 'story', 'stories'));
      setTimeout(() => { if (fetchState === IDLE) report(''); }, 3000);
    }
    renderStories();
    updateCounts();
  }
  if (t.coldMessage) {
    fetchingTab = null;
    report('');
    showListMessage();
    renderStories();
    updateCounts();
  }
  if (t.warmToast) {
    fetchingTab = null;
    report('');
    hideListMessage();          // there is content on screen, so nothing is stranded
    toast('Could not reach Hacker News. Showing the stories already loaded.', true);
  }
}

let fetchToken = 0;
let fetchController = null;
let fetchingTab = null;

function loadingText(tab) { return 'Loading ' + (TAB_LABEL[tab] || tab) + ' stories...'; }

function startFetch(tab) {
  const token = ++fetchToken;
  const controller = new AbortController();
  fetchController = controller;
  fetchingTab = tab;
  hideListMessage();
  if (tab === currentTab) report(loadingText(tab));
  fetchStories(tab, STORY_COUNT, controller.signal).then(items => {
    if (token !== fetchToken) return;       // a newer request has taken over
    stories[tab] = items;
    dispatchFetch('landed', { tab: tab });
  }).catch(err => {
    if (token !== fetchToken) return;
    if (err && err.name === 'AbortError') return;
    console.error('[hn] fetch failed', err);
    dispatchFetch(stories[tab].length ? 'failed-warm' : 'failed-cold', { tab: tab });
  });
}

function abortFetch() {
  fetchToken++;                             // anything still in flight is now stale
  if (fetchController) { fetchController.abort(); fetchController = null; }
  fetchingTab = null;
  report('');
}

// One shot per reconnect. A flaky connection cannot loop this at 501 requests
// a time: the machine only acts from Failed, and the debounce covers the burst
// of online events a single reconnect can produce.
let lastReconnectAt = 0;
window.addEventListener('online', () => {
  const now = Date.now();
  if (now - lastReconnectAt < 5000) return;
  if (FEED_TABS.indexOf(currentTab) === -1) return;
  lastReconnectAt = now;
  dispatchFetch('online', { tab: currentTab });
});

function showListMessage() {
  const box = document.getElementById('listMessage');
  box.textContent = '';
  box.appendChild(document.createTextNode('Could not reach Hacker News.'));
  box.appendChild(el('span', {
    class: 'list-message-hint',
    text: 'Nothing has loaded yet. Tap Refresh to try again.'
  }));
  box.hidden = false;
}

function hideListMessage() {
  document.getElementById('listMessage').hidden = true;
}

// Inline on desktop, through the toast on narrow screens, where the status bar
// scrolls away from a Refresh button that is pinned.
function report(msg) {
  const inline = document.getElementById('loading');
  if (!NARROW.matches) { inline.textContent = msg; return; }
  inline.textContent = '';
  if (confirmPending()) return;             // never talk over a waiting question
  if (msg) toast(msg);
  else hideToast();
}

/* ============================================================
   TABS
   ============================================================ */

function switchTab(tab) {
  currentTab = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch (e) {}
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  clearSearch();
  renderStories();
  updateCounts();
  // Carry the progress line across only if this tab is the one still loading.
  report(fetchingTab === tab ? loadingText(tab) : '');
  if (FEED_TABS.indexOf(tab) === -1) return;   // Saved is local; nothing to fetch, ever
  dispatchFetch(stories[tab].length === 0 ? 'switch-empty' : 'switch-has', { tab: tab });
}

function refreshAll() {
  if (FEED_TABS.indexOf(currentTab) === -1) {
    toast('Saved is your own list. There is nothing to refresh.');
    return;
  }
  dispatchFetch('refresh', { tab: currentTab });
}

/* ============================================================
   THE LAYER STACK
   The disclosure row and the two panels are layers of one machine,
   not two mechanisms. The invariant: exactly one history entry
   exists if and only if some layer is open, so Android back pops
   the topmost layer before it exits the app.

   Every close path routes through history.back(), which makes
   popstate the single place a layer actually closes. Swapping one
   layer for another replaces the entry rather than pushing a second,
   which keeps the invariant without a back-then-push race.
   ============================================================ */

let layer = null;              // null | 'disclosure' | 'blockedSites' | 'blockedUsers'
let closePending = false;
let pendingOpen = null;
let lastFocused = null;

function openLayer(name) {
  if (layer === name) return;
  if (closePending) { pendingOpen = name; return; }
  if (layer) {
    applyLayerClosed(layer);
    layer = name;
    applyLayerOpen(name);
    history.replaceState({ hnLayer: name }, '');
  } else {
    layer = name;
    applyLayerOpen(name);
    history.pushState({ hnLayer: name }, '');
  }
}

function closeLayer() {
  if (!layer || closePending) return;
  closePending = true;
  history.back();
}

window.addEventListener('popstate', () => {
  closePending = false;
  if (layer) {
    applyLayerClosed(layer);
    layer = null;
  }
  if (pendingOpen) {
    const next = pendingOpen;
    pendingOpen = null;
    openLayer(next);
  }
});

function applyLayerOpen(name) {
  if (name === 'disclosure') {
    document.body.classList.add('disclosure-open');
    document.getElementById('disclosureBtn').setAttribute('aria-expanded', 'true');
    return;
  }
  lastFocused = document.activeElement;
  // Belt and suspenders on the one-panel invariant: close any other panel
  // outright, and trap focus so the header behind the overlay is unreachable.
  document.querySelectorAll('.panel-overlay.open').forEach(p => p.classList.remove('open'));
  const overlay = document.getElementById(name + 'Panel');
  overlay.classList.add('open');
  if (name === 'blockedSites') renderBlockedSites();
  if (name === 'blockedUsers') renderBlockedUsers();
  if (name === 'settings') renderSettings();
  if (name === 'video') mountVideo();
  updateUndoButtons();
  dispatchFetch('panel-open');
  const close = overlay.querySelector('.panel-close');
  if (close) close.focus();
}

function applyLayerClosed(name) {
  if (name === 'disclosure') {
    document.body.classList.remove('disclosure-open');
    document.getElementById('disclosureBtn').setAttribute('aria-expanded', 'false');
    return;
  }
  document.getElementById(name + 'Panel').classList.remove('open');
  if (name === 'video') unmountVideo();
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
}

/* The player is a layer rather than a page. A same-origin, in-scope navigation
   replaces the installed app's own window, so coming back from it reloads the
   app and throws away the loaded stories and the filter. A cross-origin link
   like xcancel does not have that problem, because the browser opens it beside
   the app rather than inside it. */

let pendingVideo = null;

function openVideo(id, start) {
  pendingVideo = { id: id, start: start || 0 };
  openLayer('video');
}

function mountVideo() {
  const stage = document.getElementById('videoStage');
  stage.innerHTML = '';
  if (!pendingVideo) return;
  const { id, start } = pendingVideo;

  document.getElementById('videoOut').href =
    'https://www.youtube.com/watch?v=' + id + (start ? '&t=' + start + 's' : '');

  const frame = el('iframe', {
    src: 'https://www.youtube-nocookie.com/embed/' + id + (start ? '?start=' + start : ''),
    title: 'Video player',
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
    allowFullscreen: true
  });
  frame.setAttribute('frameborder', '0');
  stage.appendChild(frame);
}

function unmountVideo() {
  // Removing the frame is what stops playback. Closing the overlay alone would
  // leave the audio running behind the story list.
  document.getElementById('videoStage').innerHTML = '';
  pendingVideo = null;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const panel = document.querySelector('.panel-overlay.open .panel');
  if (!panel) return;
  const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(n => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

/* ============================================================
   BACKUP / RESTORE
   Storage belongs to this origin and this browser profile. It
   survives launches, updates and moving the files around the site,
   but not clearing "Cookies and other site data", not a different
   browser, and not a different device. Export is what crosses those.
   ============================================================ */

function exportBlocks() {
  const data = {
    format: 'hn-tracker-blocklist',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    sites: readList(SITES_KEY),
    users: readList(USERS_KEY),
    posts: readList(POSTS_KEY),
    saved: readSaved()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'hn-tracker-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Exported ' + plural(data.sites.length, 'site') + ', ' + plural(data.users.length, 'user') +
    ', ' + plural(data.posts.length, 'post') +
    ' and ' + plural(data.saved.length, 'saved story', 'saved stories') + '.');
}

function importBlocks(file) {
  if (blockingFrozen()) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (err) { toast('Import failed: not valid JSON.', true); return; }

    if (data.format !== 'hn-tracker-blocklist' || EXPORT_READS.indexOf(data.version) === -1) {
      toast('Import failed: this file is version ' + (data.version === undefined ? 'unknown' : data.version) +
        ', and this app reads versions ' + andList(EXPORT_READS) + '. Nothing was merged.', true);
      return;
    }

    const addedSites = [], addedUsers = [], addedPosts = [], addedSaved = [];

    // Absent from a v1 or v2 file, so this loop simply does nothing for one.
    mutateUnsorted(POSTS_KEY, list => {
      const have = new Set(list.map(p => String(p.id)));
      (data.posts || []).forEach(p => {
        const id = p && p.id !== undefined ? String(p.id) : '';
        if (!id || have.has(id)) return;
        have.add(id);
        list.push({ id: id, url: p.url || '', title: p.title || '', time: p.time || Date.now() });
        addedPosts.push(id);
      });
      return list;
    });

    mutateList(SITES_KEY, list => {
      const have = new Set(list.map(s => normHost(s.name)));
      (data.sites || []).forEach(s => {
        const n = normHost(s && s.name);
        if (!n || have.has(n)) return;
        have.add(n);
        list.push({ name: n, title: s.title || '', user: s.user || '', time: s.time || Date.now() });
        addedSites.push(n);
      });
      return list;
    });

    mutateList(USERS_KEY, list => {
      const have = new Set(list.map(u => normUser(u.name)));
      (data.users || []).forEach(u => {
        const n = normUser(u && u.name);
        if (!n || have.has(n)) return;
        have.add(n);
        list.push({ name: n, title: u.title || '', site: u.site || '', time: u.time || Date.now() });
        addedUsers.push(n);
      });
      return list;
    });

    // A v1 file has no saved list, so this loop simply does nothing for one.
    mutateSaved(list => {
      const have = new Set(list.map(s => String(s.id)));
      (data.saved || []).forEach(s => {
        const id = s && s.id !== undefined ? String(s.id) : '';
        if (!id || have.has(id)) return;
        have.add(id);
        list.push({
          id: s.id,
          title: s.title || '',
          url: s.url || '',
          domain: s.domain || null,
          user: s.user || '',
          comments: s.comments || 0,
          time: s.time || 0,
          hnLink: s.hnLink || (HN + '/item?id=' + s.id),
          savedAt: s.savedAt || Date.now()
        });
        addedSaved.push(id);
      });
      return list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    });

    if (addedSites.length || addedUsers.length || addedPosts.length || addedSaved.length) {
      const siteSet = new Set(addedSites), userSet = new Set(addedUsers);
      const postSet = new Set(addedPosts), savedSet = new Set(addedSaved);
      pushUndo({
        kind: 'import',
        label: 'import of ' + plural(addedSites.length, 'site') + ', ' + plural(addedUsers.length, 'user') +
          ', ' + plural(addedPosts.length, 'post') +
          ' and ' + plural(addedSaved.length, 'saved story', 'saved stories'),
        // Saved has no undo of its own, but the import undo still has to take
        // back everything the import put in, or it is only half an undo.
        undo: () => {
          mutateList(SITES_KEY, l => l.filter(s => !siteSet.has(normHost(s.name))));
          mutateList(USERS_KEY, l => l.filter(u => !userSet.has(normUser(u.name))));
          mutateUnsorted(POSTS_KEY, l => l.filter(p => !postSet.has(String(p.id))));
          mutateSaved(l => l.filter(s => !savedSet.has(String(s.id))));
        }
      });
    }

    refreshAllViews();
    toast('Merged in ' + plural(addedSites.length, 'new site') + ', ' + plural(addedUsers.length, 'new user') +
      ', ' + plural(addedPosts.length, 'new post') +
      ' and ' + plural(addedSaved.length, 'new saved story', 'new saved stories') + '.');
  };
  reader.onerror = () => toast('Could not read that file.', true);
  reader.readAsText(file);
}

/* ============================================================
   CROSS-TAB SYNC
   Fires in every OTHER tab when this one writes, so a second window
   never shows, or saves from, a stale list.
   ============================================================ */

window.addEventListener('storage', e => {
  if (e.key === null || e.key === SITES_KEY || e.key === USERS_KEY || e.key === POSTS_KEY || e.key === SAVED_KEY) {
    refreshAllViews();
  }
  if (e.key === null || e.key === SETTINGS_KEY) {
    renderSettings();
    renderStories();
  }
});

/* ============================================================
   UTILITIES
   ============================================================ */

let toastTimer = null;
let noteTimer = null;

function toast(msg, isError) {
  // The waiting question owns the toast body, so anything else the app has to
  // say goes underneath it. Dropping the message would make a refused block
  // look like a button that does nothing.
  if (confirmPending()) { showToastNote(msg, isError); return; }
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastActions').hidden = true;
  t.classList.remove('confirm');
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 7000 : 3500);
}

function hideToast() {
  if (confirmPending()) return;
  clearTimeout(toastTimer);
  document.getElementById('toast').classList.remove('show');
}

function showToastNote(msg, isError) {
  const n = document.getElementById('toastNote');
  n.textContent = msg;
  n.classList.toggle('error', !!isError);
  n.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { n.hidden = true; }, 5000);
}

function hideToastNote() {
  clearTimeout(noteTimer);
  const n = document.getElementById('toastNote');
  n.hidden = true;
  n.textContent = '';
}

function showConfirmToast(msg, onConfirm, onCancel) {
  const t = document.getElementById('toast');
  clearTimeout(toastTimer);
  hideToastNote();
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastActions').hidden = false;
  t.classList.remove('error');
  t.classList.add('confirm', 'show');
  const yes = document.getElementById('toastConfirm');
  const no  = document.getElementById('toastCancel');
  yes.onclick = onConfirm;
  no.onclick = onCancel;
  yes.focus();
}

function hideConfirmToast() {
  const t = document.getElementById('toast');
  hideToastNote();
  document.getElementById('toastActions').hidden = true;
  t.classList.remove('confirm', 'show');
  document.getElementById('toastConfirm').onclick = null;
  document.getElementById('toastCancel').onclick = null;
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

// "1", "1 and 2", "1, 2 and 3".
function andList(items) {
  if (items.length < 2) return String(items[0] === undefined ? '' : items[0]);
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function onSearchInput() {
  const input = document.getElementById('searchInput');
  document.getElementById('searchClear').classList.toggle('visible', input.value.length > 0);
  renderStories();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  input.value = '';
  document.getElementById('searchClear').classList.remove('visible');
  renderStories();
}

/* ============================================================
   WIRING
   ============================================================ */

document.getElementById('btnRefresh').addEventListener('click', refreshAll);
document.getElementById('btnSites').addEventListener('click', () => openLayer('blockedSites'));
document.getElementById('btnUsers').addEventListener('click', () => openLayer('blockedUsers'));
document.getElementById('viewToggleBtn').addEventListener('click', toggleBlockedView);
document.getElementById('undoBtn').addEventListener('click', performUndo);
document.getElementById('searchInput').addEventListener('input', onSearchInput);
document.getElementById('searchClear').addEventListener('click', () => { clearSearch(); document.getElementById('searchInput').focus(); });
document.getElementById('blockSiteBtn').addEventListener('click', () => addBlockedSite());
document.getElementById('blockUserBtn').addEventListener('click', () => addBlockedUser());
document.getElementById('blockSiteInput').addEventListener('keydown', e => { if (e.key === 'Enter') addBlockedSite(); });
document.getElementById('blockUserInput').addEventListener('keydown', e => { if (e.key === 'Enter') addBlockedUser(); });

document.getElementById('disclosureBtn').addEventListener('click', () => {
  if (layer === 'disclosure') closeLayer();
  else openLayer('disclosure');
});

document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

document.querySelectorAll('.panel-close').forEach(b => {
  b.addEventListener('click', closeLayer);
});

document.querySelectorAll('.panel-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeLayer(); });
});

// Export / import / undo. The undo button is no longer bound to a list: one
// global stack means both panels and the tabs row dispatch the same action.
document.querySelectorAll('.panel-tools').forEach(tools => {
  tools.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'export') exportBlocks();
    if (act === 'import') document.getElementById('importFile').click();
    if (act === 'undo') performUndo();
    // The layer machine swaps one panel for another, so this closes Blocked
    // Sites on the way and back returns to the list, not to the panel behind.
    if (act === 'settings') openLayer('settings');
  });
});

document.querySelectorAll('#settingsPanel input[data-setting]').forEach(input => {
  input.addEventListener('change', () => setSetting(input.getAttribute('data-setting'), input.checked));
});

document.getElementById('importFile').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) importBlocks(f);
  e.target.value = '';
});

// One delegated handler for every block / unblock button in the app. The two
// checks above the early return need every click, not only the ones on a
// block button: the disclosure collapses on any tap outside itself (and never
// on a scroll), and blocking is refused while an undo is waiting for an answer.
document.addEventListener('click', e => {
  if (layer === 'disclosure'
      && !e.target.closest('#disclosureBtn, #viewToggle')
      && !e.target.closest('#btnSites, #btnUsers')) {   // those swap the layer themselves
    closeLayer();
  }

  // A plain left click on a video link opens the layer. Modified clicks and
  // middle clicks fall through to the href, so "open in a new tab" still gets
  // the standalone watch page.
  const video = e.target.closest('a[data-video]');
  if (video && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
    e.preventDefault();
    openVideo(video.getAttribute('data-video'), parseInt(video.getAttribute('data-start'), 10) || 0);
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');

  // Saving is outside the undo stack, so a pending confirm does not freeze it.
  if (action === 'save-story')   { saveStory(btn.getAttribute('data-id')); return; }
  if (action === 'unsave-story') { unsaveStory(btn.getAttribute('data-id')); return; }

  if (blockingFrozen()) return;
  const name = btn.getAttribute('data-name');
  const title = btn.getAttribute('data-title') || '';
  const extra = btn.getAttribute('data-extra') || '';
  if (action === 'block-site')   addBlockedSite(name, title, extra);
  if (action === 'block-user')   addBlockedUser(name, title, extra);
  if (action === 'block-post')   addBlockedPost(btn.getAttribute('data-id'));
  if (action === 'unblock-site') removeBlockedSite(name);
  if (action === 'unblock-user') removeBlockedUser(name);
  if (action === 'unblock-post') removeBlockedPost(btn.getAttribute('data-id'));
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && layer) { closeLayer(); return; }
  trapFocus(e);
});

/* ============================================================
   SERVICE WORKER
   The worker precaches the shell and revalidates it on every launch,
   so a push reaches everyone without a version constant anyone has
   to remember to bump. A new version installs quietly and takes
   effect the next time the app is opened.
   ============================================================ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(() => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'revalidate' });
      }
    }).catch(err => console.error('[hn] service worker failed to register', err));
  });
}

/* ============================================================
   INIT
   ============================================================ */

migrateStoredLists();

const TABS = FEED_TABS.concat(['saved']);
let openingTab = null;
try { openingTab = localStorage.getItem(TAB_KEY); } catch (e) {}
if (TABS.indexOf(openingTab) === -1) openingTab = 'top';
currentTab = openingTab;
document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));

updateUndoButtons();
refreshAllViews();
// Launching on Saved fetches nothing. Top or Newest loads when first switched to.
if (FEED_TABS.indexOf(currentTab) !== -1) dispatchFetch('switch-empty', { tab: currentTab });
