-- Helper for bulk send (and any outbound to a brand-new number): upsert the
-- conversation by (telnyx_number, contact_number) and insert the outbound
-- message, so bulk sends also thread into the Inbox.

create or replace function public.telnyx_send_outbound(
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
  v_conv_id uuid;
  v_msg_id  uuid;
begin
  insert into telnyx_conversations
    (telnyx_number, contact_number, last_message_at, last_preview, last_direction, unread)
  values
    (p_from, p_to, now(), left(coalesce(p_body,''),140), 'outbound', false)
  on conflict (telnyx_number, contact_number) do update
    set last_message_at = now(),
        last_preview    = left(coalesce(p_body,''),140),
        last_direction  = 'outbound',
        unread          = false
  returning id into v_conv_id;

  insert into telnyx_messages
    (conversation_id, direction, from_number, to_number, body, telnyx_message_id, status)
  values
    (v_conv_id, 'outbound', p_from, p_to, p_body, p_telnyx_message_id, 'queued')
  returning id into v_msg_id;

  return jsonb_build_object('conversation_id', v_conv_id, 'message_id', v_msg_id);
end;
$$;

grant execute on function public.telnyx_send_outbound(text,text,text,text) to service_role;
