-- Storage policies for the private "photos" bucket (SPEC §1.7). Only runs on Supabase (storage schema exists).
-- Staff upload slips / meter / ID photos; a worker may upload only under crew/<own user id>/ (M3).
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then return; end if;
  insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict (id) do nothing;

  execute $p$create policy photos_staff_read on storage.objects for select to authenticated
           using (bucket_id = 'photos' and public.is_staff())$p$;
  execute $p$create policy photos_staff_write on storage.objects for insert to authenticated
           with check (bucket_id = 'photos' and public.is_staff())$p$;
  execute $p$create policy photos_worker_own on storage.objects for select to authenticated
           using (bucket_id = 'photos' and (storage.foldername(name))[1] = 'crew' and (storage.foldername(name))[2] = auth.uid()::text)$p$;
  execute $p$create policy photos_worker_write on storage.objects for insert to authenticated
           with check (bucket_id = 'photos' and public.my_role() = 'worker'
                       and (storage.foldername(name))[1] = 'crew' and (storage.foldername(name))[2] = auth.uid()::text)$p$;
end $$;
