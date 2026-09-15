// Service-worker side of background NWC. Bundled by build.js and appended to
// the generated sw.js, replacing the notify-only push handler: a push now
// first tries to ANSWER the request from the background state mirror (see
// nwc-respond.js), and only falls back to the wake-the-user notification
// when it can't.

import { respondFromBg } from './nwc-respond.js';
import { withRequestLock } from './nwc-lock.js';
import { bgAutoWithdraw } from './bg-autowithdraw.js';
import { allInboxes, classifyDm, shouldNotifyDm } from './dm-inbox.js';

const NOTIFIER = 'https://nwcpush.coinos.io';

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  // User-facing notifications (payments, DMs, community chat). An open
  // window already shows everything live — stay quiet then.
  if (data.type === 'notify') {
    e.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.some((c) => c.visibilityState === 'visible')) return;
      // Money landing is exactly when a forwarding rule wants to run, and this
      // wake-up is the only moment the worker gets. Failures are recorded in
      // the mirror; the notification still goes out either way.
      if (data.reason === 'payment') {
        try { await bgAutoWithdraw({ log: (m) => console.log('[sw-aw]', m) }); }
        catch (err) { console.warn('[sw-aw] failed:', err && err.message); }
      }
      // A DM arrives wrapped, so only this device can see who sent it. Open it
      // here: a message from someone we follow gets their name on it, our own
      // sent-copy and a stranger's get nothing at all. Anything we can't open
      // — a remote-signer wallet, an oversized wrap — falls through to the
      // generic notification rather than being dropped silently.
      let dmName = null;
      if (data.reason === 'dm' && data.wrap) {
        try {
          const verdict = await classifyDm(data.wrap, await allInboxes());
          if (!shouldNotifyDm(verdict)) return;
          if (verdict && verdict.name) dmName = verdict.name;
        } catch (err) { console.warn('[sw-dm] could not classify:', err && err.message); }
      }
      const T = {
        payment: ['Payment received', data.amountSat ? `+${Number(data.amountSat).toLocaleString()} sats — open coinos to see it.` : 'Open coinos to see it.'],
        dm: dmName ? [dmName, 'sent you a message.'] : ['New message', 'You have a new private message.'],
        chat: ['New chat activity', 'There are new messages in your communities.'],
        mention: [data.reply ? 'New reply to your post' : 'You were mentioned', data.text || 'Open coinos to see it.'],
      };
      const [title, body] = T[data.reason] || T.chat;
      // a reply lands you in the Notifications list, where it is
      const target = data.reason === 'mention' ? { url: './?open=notifs', view: 'notifs' } : { url: './' };
      await self.registration.showNotification(title, {
        body,
        icon: 'icon-192.png', badge: 'badge-96.png',
        tag: 'notify-' + (data.reason || 'chat'), renotify: data.reason === 'payment' || data.reason === 'mention',
        data: target,
      });
    })());
    return;
  }
  if (data.type !== 'nwc') return;
  e.waitUntil((async () => {
    // An open window handles requests itself with full wallet state — nudge
    // it and stay out of the way.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length) {
      for (const c of clients) c.postMessage({ type: 'nwc-wake', servicePubkey: data.servicePubkey });
      return;
    }
    // an NWC wake-up may also have moved money in; check the rule after
    setTimeout(() => { bgAutoWithdraw({ log: (m) => console.log('[sw-aw]', m) }).catch(() => {}); }, 0);
    let handled = false;
    try {
      handled = await withRequestLock(data.event && data.event.id,
        () => respondFromBg(data, { notifier: NOTIFIER, log: (m) => console.log('[sw-nwc]', m) }),
        () => { console.log('[sw-nwc] another context holds this request'); return true; });
    } catch (err) {
      console.warn('[sw-nwc] auto-answer failed:', err && err.message);
    }
    // handled-with-a-heads-up: e.g. an invoice was minted while closed and
    // the user should open coinos to complete the receive
    if (handled && handled.notify) {
      await self.registration.showNotification(handled.notify.title, {
        body: handled.notify.body,
        icon: 'icon-192.png', badge: 'badge-96.png',
        tag: handled.notify.tag || 'nwc-incoming', renotify: true,
        data: { url: './' },
      });
      return;
    }
    if (handled) return;
    // A kind-21001 offer request is money coming IN (someone asking us to
    // mint an invoice) — "an app wants to pay" would read as the opposite.
    const incoming = data.event && data.event.kind === 21001;
    await self.registration.showNotification(incoming ? 'Incoming payment' : 'Payment request', {
      body: incoming
        ? 'Someone is trying to send you money. Open coinos so your wallet can receive it.'
        : 'An app is asking your wallet to pay. Open Coinos to approve.',
      icon: 'icon-192.png', badge: 'badge-96.png',
      tag: 'nwc-' + (data.servicePubkey || 'req'), renotify: false,
      data: { url: './' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = (e.notification && e.notification.data) || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => 'focus' in c);
    if (open) {
      // an open window goes where the notification points, without reloading
      if (d.view) { try { open.postMessage({ type: 'open', view: d.view }); } catch (_) {} }
      return open.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(d.url || './');
  })());
});
