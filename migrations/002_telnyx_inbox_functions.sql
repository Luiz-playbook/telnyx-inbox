-- Telnyx 2-Way SMS Inbox — RPC functions
-- Called by the n8n workflows via the Supabase REST /rpc endpoint using the
-- SERVICE ROLE key. Each function is atomic, so n8n needs only ONE call per event
-- (no read-modify-write races, dedupe handled in SQL).

-- ── Inbound: upsert the conversation + insert the inbound message ─────────────
create or replace function public.telnyx_ingest_inbound(
  p_telnyx_number    text,
  p_contact_number   text,
  p_body             text,
  p_media            jsonb,
  p_telnyx_message_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv_id uuid;
  v_msg_id  uuid;
begin
  insert into telnyx_conversations
    (telnyx_number, contact_number, last_message_at, last_preview, last_direction, unread)
  values
    (p_telnyx_number, p_contact_number, now(), left(coalesce(p_body,''), 140), 'inbound', true)
  on conflict (telnyx_number, contact_number) do update
    set last_message_at = now(),
        last_preview    = left(coalesce(p_body,''), 140),
        last_direction  = 'inbound',
        unread          = true
  returning id into v_conv_id;

  insert into telnyx_messages
    (conversation_id, direction, from_number, to_number, body, media, telnyx_message_id)
  values
    (v_conv_id, 'inbound', p_contact_number, p_telnyx_number, p_body, p_media, p_telnyx_message_id)
  on conflict (telnyx_message_id) where telnyx_message_id is not null do nothing
  returning id into v_msg_id;

  return jsonb_build_object(
    'conversation_id', v_conv_id,
    'message_id',      v_msg_id,
    'deduped',         v_msg_id is null   -- true = Telnyx retry we ignored
  );
end;
$$;

-- ── Outbound: record a reply we just sent + mark the thread read ──────────────
create or replace function public.telnyx_record_outbound(
  p_conversation_id  uuid,
  p_from             text,
  p_to               text,
  p_body             text,
  p_telnyx_message_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg_id uuid;
begin
  insert into telnyx_messages
    (conversation_id, direction, from_number, to_number, body, telnyx_message_id, status)
  values
    (p_conversation_id, 'outbound', p_from, p_to, p_body, p_telnyx_message_id, 'queued')
  returning id into v_msg_id;

  update telnyx_conversations
     set last_message_at = now(),
         last_preview    = left(coalesce(p_body,''), 140),
         last_direction  = 'outbound',
         unread          = false
   where id = p_conversation_id;

  return jsonb_build_object('message_id', v_msg_id);
end;
$$;

-- ── Status: apply a delivery status from a message.finalized webhook ──────────
create or replace function public.telnyx_update_status(
  p_telnyx_message_id text,
  p_status            text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update telnyx_messages
     set status = p_status
   where telnyx_message_id = p_telnyx_message_id;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('updated', v_rows);
end;
$$;

grant execute on function public.telnyx_ingest_inbound(text,text,text,jsonb,text) to service_role;
grant execute on function public.telnyx_record_outbound(uuid,text,text,text,text) to service_role;
grant execute on function public.telnyx_update_status(text,text)                 to service_role;
