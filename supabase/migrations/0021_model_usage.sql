create table if not exists public.model_usage (
  response_id text primary key,
  campaign_id uuid references public.campaigns(id) on delete set null,
  stage text not null,
  model text not null,
  input_tokens bigint not null,
  cached_tokens bigint not null,
  output_tokens bigint not null,
  estimated_usd numeric(16,8),
  response_status text not null,
  created_at timestamptz not null default now()
);
create index if not exists model_usage_campaign on public.model_usage(campaign_id);
alter table public.model_usage enable row level security;
revoke all on public.model_usage from anon, authenticated;
grant all on public.model_usage to service_role;
