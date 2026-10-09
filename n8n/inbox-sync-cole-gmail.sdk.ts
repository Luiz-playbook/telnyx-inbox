// [Inbox] [Sync] Cole Gmail -> SendBlaster — n8n Workflow SDK source (AI-1102).
//
// The committed record of the workflow, in the form it was created through n8n's MCP. The other
// files in this folder are JSON exports; this one is SDK code because that is what built it, and
// the SDK text is what a diff can read. If the live workflow is edited in the n8n UI, export it
// here as JSON alongside, the way the others are kept.
//
// WHAT IT DOES. Daily at 06:00: pull the last two days of Cole's Gmail through the
// "Google Service Account | Cole" credential, classify each message as demo_booking / other on
// subject + sender + snippet, and upsert every one into public.inbox_emails (migration 106).
// The SendBlaster inbox tab reads that table and filters by Gmail label.
//
// WHY TWO DAYS FOR A DAILY RUN. Overlap on purpose: a run that is late, skipped, or that
// Gmail answers slowly cannot leave a gap, and the upsert on (source, gmail_message_id) means
// the overlap never writes a row twice. Re-running by hand is equally harmless.
//
// WHY EVERY MESSAGE IS STORED, NOT JUST THE MATCHES. A wrongly-dropped email is invisible
// forever; a wrongly-classified one is a filter away from being found. The tab shows demo
// bookings by default and can show the rest.
//
// WHY SUBJECT + SNIPPET AND NOT THE BODY. The Gmail node's `simple: false` fetches and parses
// the full MIME of every message and is a documented cause of out-of-memory runs. A demo
// booking announces itself in the subject and first lines; the ~200-char snippet is enough for
// the POC. If precision turns out to need the body, switch to simple:false with a small batch.
//
// SERVICE ACCOUNT, NOT OAUTH. Cole never has to click consent, the token never expires, and a
// Workspace admin grants exactly gmail.readonly through domain-wide delegation. The credential
// must impersonate cole@callplaybook.com; a 400 "Precondition check failed" from Gmail is that
// delegation missing. See docs/gmail-import-permissions (the AC4 note for Marx).
//
// BACKFILL. Change the q filter to newer_than:365d and execute once by hand. ~15k messages is
// ~75k Gmail API quota units, well inside the per-user daily quota; the classifier is the slow
// part at ~5 per batch.

import { workflow, node, trigger, sticky, newCredential, languageModel, expr } from '@n8n/workflow-sdk';

const dailyAtSix = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Daily 06:00 Sync',
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 6, triggerAtMinute: 0 }] } },
    position: [200, 300]
  },
  output: [{ timestamp: '2026-10-08T06:00:00' }]
});

const pullColeMail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: "Pull Cole's Gmail (last 2 days)",
    parameters: {
      resource: 'message',
      operation: 'getAll',
      authentication: 'serviceAccount',
      returnAll: true,
      simple: true,
      filters: { q: 'newer_than:2d -in:spam -in:trash', readStatus: 'both' }
    },
    credentials: { googleApi: { id: 'PI3b5e3QSyRy5S1a', name: 'Google Service Account | Cole' } },
    position: [460, 300]
  },
  output: [{ id: '18f2a1b2c3d4e5f6', threadId: '18f2a1b2c3d4e5f6', From: 'Jamie Reyes <jamie@eastsidesoccer.org>', To: 'cole@callplaybook.com', Subject: 'Demo this week?', snippet: 'Hi Cole, can we book a demo for Thursday afternoon?', internalDate: '1791446400000', labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_12', name: 'Demos' }] }]
});

const shapeRow = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Shape as inbox_emails row',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'src', name: 'source', value: 'gmail:cole', type: 'string' },
          { id: 'mid', name: 'gmail_message_id', value: expr('{{ $json.id }}'), type: 'string' },
          { id: 'tid', name: 'gmail_thread_id', value: expr('{{ $json.threadId }}'), type: 'string' },
          { id: 'fe', name: 'from_email', value: expr('{{ (($json.From || "").match(/<([^>]+)>/) || [])[1] || ($json.From || "").trim() }}'), type: 'string' },
          { id: 'fn', name: 'from_name', value: expr('{{ ($json.From || "").replace(/<[^>]+>/, "").replace(/"/g, "").trim() }}'), type: 'string' },
          { id: 'te', name: 'to_email', value: expr('{{ $json.To || "" }}'), type: 'string' },
          { id: 'sub', name: 'subject', value: expr('{{ $json.Subject || "" }}'), type: 'string' },
          { id: 'snip', name: 'snippet', value: expr('{{ $json.snippet || "" }}'), type: 'string' },
          { id: 'lab', name: 'labels', value: expr('{{ ($json.labels || []).map(l => l.name).filter(Boolean) }}'), type: 'array' },
          { id: 'rcv', name: 'received_at', value: expr('{{ $json.internalDate ? new Date(Number($json.internalDate)).toISOString() : null }}'), type: 'string' },
          { id: 'txt', name: 'classify_text', value: expr('From: {{ $json.From }}\nSubject: {{ $json.Subject }}\n{{ $json.snippet }}'), type: 'string' }
        ]
      }
    },
    position: [720, 300]
  },
  output: [{ source: 'gmail:cole', gmail_message_id: '18f2a1b2c3d4e5f6', gmail_thread_id: '18f2a1b2c3d4e5f6', from_email: 'jamie@eastsidesoccer.org', from_name: 'Jamie Reyes', to_email: 'cole@callplaybook.com', subject: 'Demo this week?', snippet: 'Hi Cole, can we book a demo for Thursday afternoon?', labels: ['INBOX', 'Demos'], received_at: '2026-10-08T00:00:00.000Z', classify_text: 'From: Jamie Reyes\nSubject: Demo this week?\nHi Cole, can we book a demo' }]
});

const classifierModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI (classifier)',
    parameters: { model: { __rl: true, mode: 'list', value: 'gpt-5-mini' }, options: { temperature: 0 } },
    position: [980, 520]
  }
});

const isDemoBooking = node({
  type: '@n8n/n8n-nodes-langchain.textClassifier',
  version: 1.1,
  config: {
    name: 'Is it about booking a demo?',
    parameters: {
      inputText: expr('{{ $json.classify_text }}'),
      categories: {
        categories: [
          { category: 'demo_booking', description: 'The sender wants to book, schedule, reschedule, confirm, or ask about a demo, walkthrough, call or meeting with Playbook, or is replying about one that was offered. Includes calendar invites and confirmations for a demo.' },
          { category: 'other', description: 'Anything else: newsletters, receipts, notifications, internal mail, vendor outreach, general questions not about a demo.' }
        ]
      },
      options: { multiClass: false, fallback: 'other', batching: { batchSize: 5, delayBetweenBatches: 200 } }
    },
    subnodes: { model: classifierModel },
    position: [980, 300]
  },
  output: [{ source: 'gmail:cole', gmail_message_id: '18f2a1b2c3d4e5f6', subject: 'Demo this week?' }]
});

const markDemo = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Mark: demo booking',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: { assignments: [
        { id: 'd1', name: 'is_demo_booking', value: true, type: 'boolean' },
        { id: 'd2', name: 'classifier_reason', value: 'Text Classifier: demo_booking (subject + sender + snippet)', type: 'string' },
        { id: 'd3', name: 'classified_at', value: expr('{{ $now.toISO() }}'), type: 'string' }
      ] }
    },
    position: [1260, 200]
  },
  output: [{ source: 'gmail:cole', gmail_message_id: '18f2a1b2c3d4e5f6', is_demo_booking: true, classifier_reason: 'Text Classifier: demo_booking', classified_at: '2026-10-08T06:00:10.000Z' }]
});

const markOther = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Mark: not a demo booking',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: { assignments: [
        { id: 'o1', name: 'is_demo_booking', value: false, type: 'boolean' },
        { id: 'o2', name: 'classifier_reason', value: 'Text Classifier: other', type: 'string' },
        { id: 'o3', name: 'classified_at', value: expr('{{ $now.toISO() }}'), type: 'string' }
      ] }
    },
    position: [1260, 420]
  },
  output: [{ source: 'gmail:cole', gmail_message_id: '18f2a1b2c3d4e5f7', is_demo_booking: false, classifier_reason: 'Text Classifier: other', classified_at: '2026-10-08T06:00:10.000Z' }]
});

const upsertRow = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Upsert into inbox_emails',
    // stopWorkflow, deliberately. The first cut used continueRegularOutput and a 401 on every
    // row still produced a green run with nothing written. A sync that fails must fail where
    // someone looks.
    onError: 'stopWorkflow',
    parameters: {
      method: 'POST',
      url: 'https://snfmggrnyjayuuxafats.supabase.co/rest/v1/inbox_emails?on_conflict=source,gmail_message_id',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'supabaseApi',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [ { name: 'Prefer', value: 'resolution=merge-duplicates,return=minimal' } ] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ source: $json.source, gmail_message_id: $json.gmail_message_id, gmail_thread_id: $json.gmail_thread_id, from_email: $json.from_email, from_name: $json.from_name, to_email: $json.to_email, subject: $json.subject, snippet: $json.snippet, labels: $json.labels, received_at: $json.received_at, is_demo_booking: $json.is_demo_booking, classifier_reason: $json.classifier_reason, classified_at: $json.classified_at, synced_at: $now.toISO() }) }}'),
      options: { batching: { batch: { batchSize: 20, batchInterval: 500 } } }
    },
    // Supabase n8n, NOT Supabase | John. The latter holds a key this project rejects (401 Invalid
    // API key) - found on the first real run, when every row failed and the run still reported
    // success. It is also the credential the Telnyx bulk-send workflow records with, which is
    // the likely reason telnyx_messages has been empty since July.
    credentials: { supabaseApi: { id: 'bdqDEVMlOhKFRx1e', name: 'Supabase n8n' } },
    position: [1540, 300]
  },
  output: [{}]
});

const note = sticky('## Cole\'s Gmail → SendBlaster inbox (AI-1102)\n\nRuns daily at 06:00. Pulls the last 2 days of mail through the Cole service account (overlap on purpose: the upsert makes re-runs harmless), classifies each by subject + sender + snippet, and upserts every message into public.inbox_emails with is_demo_booking set. The SendBlaster tab reads that table and filters by label.\n\nThe service-account credential must impersonate cole@callplaybook.com with gmail.readonly. If Gmail returns 400 "Precondition check failed", that is the delegation missing.\n\nTo backfill 6–12 months: change the q filter to newer_than:365d and run once by hand.', [pullColeMail, shapeRow], { color: 4 });

export default workflow('inbox-sync-cole-gmail', '[Inbox] [Sync] Cole Gmail → SendBlaster')
  .add(dailyAtSix)
  .to(pullColeMail)
  .to(shapeRow)
  .to(isDemoBooking.output(0).to(markDemo.to(upsertRow)))
  .add(isDemoBooking.output(1).to(markOther.to(upsertRow)))
  .add(note)
  .group('Pull mailbox', [pullColeMail, shapeRow], { description: 'Last 2 days of Cole\'s Gmail via the service account, shaped into inbox_emails columns' })
  .group('Classify and store', [isDemoBooking, classifierModel, markDemo, markOther, upsertRow], { description: 'Text Classifier on subject + sender + snippet, then one upsert per message on (source, gmail_message_id) so the daily overlap never duplicates' });
