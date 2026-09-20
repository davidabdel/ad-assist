-- Durable results for Netlify background operations. User tokens are never stored.
create table public.background_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.users(id) on delete cascade,
 fingerprint text not null,
 path text not null,
 body text not null default '',
 state text not null default 'queued' check (state in ('queued','running','completed','failed')),
 result jsonb,
 http_status integer,
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
create unique index background_jobs_active on public.background_jobs(user_id,fingerprint) where state in ('queued','running');
alter table public.background_jobs enable row level security;
revoke all on public.background_jobs from public,anon,authenticated;
grant all on public.background_jobs to service_role;
