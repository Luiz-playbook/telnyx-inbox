# Do-not-contact lists

Drop CSV files in this folder, then run:

```
node scripts/import-suppression.js
```

It reads every `.csv` here, loads the records into `do_not_contact`, and prints what it did.

---

## The CSVs are not committed, on purpose

`.gitignore` excludes everything in here except this file. These lists are real people's email
addresses and phone numbers — specifically people who have asked not to be contacted, which makes
them the last data that should sit in a git repo, on a laptop, or in a cloud backup of one.

**The database is the record. The CSV is a courier.** Once a file has been imported you can
delete it; nothing downstream reads this folder.

---

## What the file needs

One row per person. Column names are matched loosely, case and punctuation ignored, so most
exports work untouched. Recognised headers:

| For | Any of these column names |
|---|---|
| Email | `email`, `email address`, `e-mail`, `work email`, `contact email` |
| Phone | `phone`, `phone number`, `mobile`, `cell`, `telephone`, `number` |
| Name | `name`, `full name`, `contact name`, `first name` + `last name` |
| Organisation | `organization`, `organisation`, `company`, `org`, `account` |
| Reason | `reason`, `note`, `notes`, `why`, `comment` |

**At least one of email or phone is required per row.** A row with neither is skipped and
reported — there is nothing to suppress.

Anything else in the file is ignored, so extra columns are fine.

### Minimal example

```csv
email,phone,organization,reason
coach@example.com,(615) 555-0142,Nashville Youth Baseball,asked to be removed 2026-09-12
,+16155550199,Franklin Rec,verbal opt-out on a call
office@example.org,,Brentwood Soccer Club,
```

---

## What happens to the values

Phone numbers are normalised to E.164 (`+16155550142`) and emails lower-cased and trimmed, using
**the same functions the send path uses** — `norm_phone_e164` and `sendable_email`, from
migrations 073 and 082. That matters: a suppression list that normalises differently from the
send would fail to match the very people it is meant to protect, and would do so silently.

So `(615) 555-0142`, `615-555-0142` and `+1 615 555 0142` are all the same entry, and importing
the same file twice changes nothing.

---

## Re-importing is safe

Entries are keyed on the normalised email or phone. Importing the same file again updates the
existing rows rather than duplicating them, so you can re-run after fixing a typo, and you can
drop in a corrected export without cleaning up first.

---

## What this does NOT yet do

**Nothing consults this list when a blast is sent.** The table exists and can be filled; the send
path does not read it yet — that is a separate, deliberate step (see migration 085's header).

Until it is wired, this is a record of who should not be contacted, not a guarantee that they
will not be. Worth knowing, because a list that is loaded but not enforced is in some ways worse
than no list: it is evidence you knew.
