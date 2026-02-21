# Aggie Connect - Architecture Decisions & Tech Debt

## 1. Contact Number Resolution

### Problem
WhatsApp multi-device returns an internal "linked device ID" (`@lid` suffix)
for `msg.author`, not the sender's actual phone number.

### Chosen Approach
Use `contact.id.user` from the resolved contact object, which returns the
real phone number (e.g. `15126669571`). Falls back to `msg.author` then
`msg.from` if contact resolution fails.

### Alternatives Considered
- **Keep both IDs**: Store `@lid` in a separate `wa_id` column for traceability,
  real number in `source_contact`. Rejected as the `@lid` has no practical use
  and adds schema complexity.
- **Rename column**: Rename `source_contact` to `whatsapp_source_contact_id`,
  add new `source_contact`. Rejected - requires column rename migration on
  existing data across two tables.

---

## 2. Group Monitoring

### Problem
Adding/removing monitored groups required editing `.env` and restarting the bot.
Not practical for non-technical operators.

### Chosen Approach
`monitored_groups` table in Supabase. The bot:
1. On startup, seeds all WhatsApp groups into the table (with `active = false`).
2. Loads all `active = true` groups into an in-memory Set.
3. Polls every 60 seconds for rows where `updated_at > last_checked_at`.
4. If changes detected, reloads the full active group list.

An `updated_at` column with a database trigger auto-updates on any row change,
so toggling `active` in the Supabase Table Editor is all that's needed.

### Alternatives Considered
- **Bot command (!monitor)**: Send `!monitor` in a group to add it. Pros: instant,
  no UI needed. Cons: visible to all group members, looks robotic, could annoy
  users. Rejected for UX reasons.
- **Monitor all groups**: Listen to every group, filter later. Pros: zero config.
  Cons: wastes LLM calls on irrelevant groups, privacy concern. Rejected.
- **Supabase Realtime subscription**: Use Supabase's realtime WebSocket instead
  of polling. Pros: instant updates. Cons: adds a persistent WebSocket connection,
  more complex error handling, overkill for a config table that changes rarely.
  Could revisit if polling latency matters.

### Tech Debt
- `.env` `TARGET_GROUPS` is no longer used but still exists in `.env.example`.
  Should be removed once DB-based monitoring is confirmed stable.
- The 60-second poll interval is hardcoded. Could be configurable.

---

## 3. Request Deduplication

### Problem
Users cross-post the same ride request to multiple WhatsApp groups.
This creates duplicate entries in the `requests` table, duplicate LLM calls,
and false match inflation.

### Chosen Approach: Structured Hash Dedup
After the LLM parses a message into structured data, compute a hash:
```
SHA256(sender_phone | type | category | destination | date) -> first 16 chars
```
Before inserting into `requests`, check if an open request with the same hash
exists. If so, skip the insert and log a dedup message.

This is stored as `request_hash` on the `requests` table.

### Why This Works
- Same person, same message, different groups -> same structured output -> same
  hash -> deduped.
- Same person, slightly reworded but same intent ("need ride to Houston Friday"
  vs "anyone going to Houston on Friday?") -> LLM normalizes both to the same
  type/category/destination/date -> same hash -> deduped.
- Same person, genuinely different trip (different date or destination) ->
  different hash -> both saved (correct).
- Different people, same destination/date -> different sender -> different hash
  -> both saved (correct).

### Why Dedup at Request Level, Not Message Level
The LLM acts as a normalizer. Two differently-worded messages that express the
same intent will produce the same structured data. Deduping at the raw message
level (text hash) would miss these semantic duplicates. The LLM call costs
~$0 on Llama 3 free tier, so running it on cross-posts is acceptable.

### Alternatives Considered
- **Raw message text hash on message_log**: Skip LLM entirely for exact
  cross-posts. Pros: saves LLM calls. Cons: misses semantic duplicates
  (reworded messages), and the LLM cost is effectively zero on free models.
  Could add this as an optimization layer later if LLM costs increase.
- **Time-windowed dedup (TTL)**: Include date-of-posting in the hash so the
  same request posted a month later is treated as new. Not implemented yet
  because `status` field handles this - once a request is `matched` or
  `resolved`, its hash is no longer checked (we only check `status = 'open'`).
- **Database unique constraint on request_hash**: Instead of check-then-insert,
  use `INSERT ... ON CONFLICT DO NOTHING`. Pros: race-condition-proof.
  Cons: Supabase JS client doesn't expose `ON CONFLICT` cleanly for non-PK
  columns. Could add a unique partial index later:
  `CREATE UNIQUE INDEX ON requests(request_hash) WHERE status = 'open'`.
- **Fuzzy/embedding-based dedup**: Use vector similarity on the raw message
  text to catch near-duplicates. Overkill for now - the LLM normalization
  handles this adequately.

### Tech Debt
- **No unique constraint**: Currently uses check-then-insert (two queries).
  A race condition could theoretically create duplicates if two identical
  messages arrive in the same millisecond. Low risk given message volume.
  Fix: add `CREATE UNIQUE INDEX idx_requests_hash_open ON requests(request_hash) WHERE status = 'open'`.
- **Hash doesn't include origin**: Two requests from the same person to the
  same destination on the same date but from different origins would be
  deduped. This is acceptable for now since origin is almost always
  "College Station", but should be revisited if the platform expands
  geographically.
- **No dedup for reposted-next-day scenario**: If someone posts "need ride
  Friday" on Monday and again on Tuesday (because no match yet), both parse
  to the same date -> same hash -> deduped. This is correct behavior. But
  if they post "need ride Friday" and then "need ride Saturday" (genuinely
  new trip), the different date produces a different hash -> both saved.
  Edge case: they repost the same request weeks later for a new trip on the
  same date. The old request would need to be `resolved`/`expired` first.
  Automated request expiry is not yet implemented.
- **Request expiry**: Old open requests should eventually be auto-expired
  (e.g. requests with dates in the past). Not implemented yet. This would
  free up hashes for legitimate re-requests.

---

## 4. Message Parsing (LLM)

### Chosen Approach
Every non-trivial message is sent to a Llama 3 8B model via OpenRouter.
A system prompt instructs the model to classify messages and extract structured
data. Temperature is set to 0.1 for deterministic output.

### Tech Debt
- **No batching**: Each message is a separate API call. If message volume
  increases significantly, batching recent messages into a single call
  could reduce latency and cost.
- **No caching**: Identical messages (before LLM) aren't cached. Could add
  an in-memory LRU cache keyed on message text to skip repeat calls.
- **Model fallback**: If OpenRouter is down or rate-limited, messages are
  logged with an error but not retried. Could add a retry queue.
- **Prompt is ride-focused**: The system prompt handles rides well but
  housing, tutoring, and other categories are minimal. Should be expanded
  as those use cases grow.
- **No feedback loop**: There's no way to correct the LLM's classification.
  A future admin UI could allow marking false positives/negatives, which
  could be used for prompt tuning or fine-tuning.

---

## 5. Matching Engine

### Chosen Approach
When a new request is saved, query for open requests of the opposite type
(need <-> offer) with the same category and destination, within +/- 1 day.
Score based on date proximity and location match.

### Tech Debt
- **Only exact destination match for rides**: "Houston" and "Houston IAH"
  would not match. The normalizer handles common variants but isn't exhaustive.
- **No notification**: Matches are logged to console and stored in DB but
  nobody is notified. Future: send WhatsApp message to both parties, or
  notify an admin.
- **No manual match/unmatch**: An admin can't manually create or break
  matches from the UI yet.
- **Score threshold (0.5) is arbitrary**: Should be tuned based on real data.
