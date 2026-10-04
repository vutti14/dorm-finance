-- จดมิเตอร์: show the saved photo of the water meter too (found in the browser run: after the electricity reading is
-- saved the screen opens on the water meter, whose photo was not returned). Adds water_photo_path to meter_sheet().
drop function meter_sheet(uuid);
create or replace function meter_sheet(p_round uuid)
returns table (room_id uuid, code text, building_id text, room_status room_status_t, tenant_name text,
               water_flat numeric, elec_prev numeric, elec_curr numeric, elec_units numeric, prev_units numeric,
               water_prev numeric, water_curr numeric, ai_value numeric, photo_path text, read_by_name text,
               read_at timestamptz, flags text[], total numeric, elec_rate numeric, water_rate numeric, water_photo_path text)
language sql stable security definer set search_path = public as $$
  select ro.id, ro.code, ro.building_id, ro.status, b.tenant_name, ro.water_flat,
         coalesce(b.elec_prev, (select l.curr from last_reading(ro.id, 'elec', p_round) l)),
         b.elec_curr, b.elec_units,
         coalesce(me.prev_units, (select l.units from last_reading(ro.id, 'elec', p_round) l)),
         coalesce(b.water_prev, (select l.curr from last_reading(ro.id, 'water', p_round) l)),
         b.water_curr, me.ai_value, me.photo_path, me.read_by_name, me.read_at, b.flags, b.total,
         coalesce(ro.elec_rate_override, (rd.rates->>'elec')::numeric), (rd.rates->>'water')::numeric,
         (select mw.photo_path from meter_readings mw where mw.round_id = b.round_id and mw.room_id = b.room_id and mw.kind = 'water')
    from bills b join rooms ro on ro.id = b.room_id join bill_rounds rd on rd.id = b.round_id
    left join meter_readings me on me.round_id = b.round_id and me.room_id = b.room_id and me.kind = 'elec'
   where b.round_id = p_round and ro.has_meter and is_staff()
   order by ro.building_id, ro.code
$$;
grant execute on function meter_sheet(uuid) to authenticated;
