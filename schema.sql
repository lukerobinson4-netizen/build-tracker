-- ================================================================
-- 128 Dairy Creek Road — Build Tracker
-- Supabase Schema — run once in SQL Editor → New Query → Run
-- ================================================================

-- ── DOCUMENTS (quotes & invoices) ──────────────────────────────
create table if not exists docs (
  id              text primary key,
  type            text not null default 'quote',
  status          text not null default 'pending',
  supplier        text,
  trade           text,
  description     text,
  docnum          text,
  doc_date        text,
  expiry          text,
  amount          numeric(12,2) default 0,
  gst             numeric(12,2) default 0,
  notes           text,
  payments        jsonb default '[]',
  attachment_name text,
  import_method   text,
  bank_details    jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── DATES (milestones, Gantt, timeline) ────────────────────────
create table if not exists dates (
  id            text primary key,
  title         text not null,
  date          text,
  end_date      text,
  type          text,
  trade         text,
  priority      text default 'med',
  notes         text,
  source        text default 'manual',
  source_doc    text,
  done          boolean default false,
  actioned_date text,
  deps          jsonb default '[]',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── TASKS ──────────────────────────────────────────────────────
create table if not exists tasks (
  id             text primary key,
  title          text not null,
  description    text,
  cat            text,
  status         text default 'open',
  closure_note   text,
  priority       text default 'med',
  due            text,
  assign         text,
  linked_doc     text,
  linked_contact text,
  done           boolean default false,
  notes          text,
  subtasks       jsonb default '[]',
  created        text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ── CONTACTS ───────────────────────────────────────────────────
create table if not exists contacts (
  id          text primary key,
  name        text,
  company     text,
  supplier    text,
  role        text,
  trade       text,
  mobile      text,
  phone       text,
  email       text,
  address     text,
  abn         text,
  licence     text,
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── QUESTIONS ──────────────────────────────────────────────────
create table if not exists questions (
  id             text primary key,
  question_text  text not null,
  for_name       text,
  linked_contact text,
  linked_doc     text,
  asked          text,
  answer         text,
  answered       text,
  priority       text default 'med',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- ── SETTINGS (trades, suppliers, task_cats stored as JSON) ─────
create table if not exists settings (
  key        text primary key,
  value      jsonb not null default '[]',
  updated_at timestamptz default now()
);

-- Seed default setting rows so upserts always work
insert into settings (key, value) values
  ('trades',    '[]'),
  ('suppliers', '[]'),
  ('task_cats', '[]')
on conflict (key) do nothing;

-- ── Auto-update updated_at ──────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger docs_updated_at      before update on docs      for each row execute function update_updated_at();
create or replace trigger dates_updated_at     before update on dates     for each row execute function update_updated_at();
create or replace trigger tasks_updated_at     before update on tasks     for each row execute function update_updated_at();
create or replace trigger contacts_updated_at  before update on contacts  for each row execute function update_updated_at();
create or replace trigger questions_updated_at before update on questions  for each row execute function update_updated_at();
create or replace trigger settings_updated_at  before update on settings  for each row execute function update_updated_at();

-- ── Row Level Security ──────────────────────────────────────────
-- Enable RLS on all tables so only authenticated requests can read/write.
-- Since this is a single-user personal app we use a simple anon key policy
-- gated by a shared secret stored as a Postgres setting.
-- For now we allow all operations with the anon key (simplest setup).
-- You can tighten this later by adding Supabase Auth.

alter table docs      enable row level security;
alter table dates     enable row level security;
alter table tasks     enable row level security;
alter table contacts  enable row level security;
alter table questions enable row level security;
alter table settings  enable row level security;

-- Allow all CRUD with anon key (your anon key is private — only you have it)
create policy "anon full access" on docs      for all using (true) with check (true);
create policy "anon full access" on dates     for all using (true) with check (true);
create policy "anon full access" on tasks     for all using (true) with check (true);
create policy "anon full access" on contacts  for all using (true) with check (true);
create policy "anon full access" on questions for all using (true) with check (true);
create policy "anon full access" on settings  for all using (true) with check (true);

-- ── Done ────────────────────────────────────────────────────────
-- After running: go to Table Editor to verify 6 tables were created.
