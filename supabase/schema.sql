-- my-service-list: Supabase schema
-- Supabase の SQL Editor でそのまま実行する。何度実行しても壊れないように書いてある。

-- 開発段階
do $$
begin
  if not exists (select 1 from pg_type where typname = 'service_stage') then
    create type public.service_stage as enum (
      'planning',    -- 企画
      'developing',  -- 開発中
      'released',    -- 公開中
      'paused',      -- 休止
      'retired'      -- 終了
    );
  end if;
end $$;

-- サービスのマスタ
create table if not exists public.services (
  id                      bigint generated always as identity primary key,
  name                    text not null check (length(trim(name)) > 0),
  description             text,
  stage                   public.service_stage not null default 'planning',
  github_repo             text check (github_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  url                     text check (url ~ '^https?://'),
  uptimerobot_monitor_id  bigint,
  tags                    text[] not null default '{}',
  released_on             date,
  note                    text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- あとから足した列。作成済みのテーブルにも足せるように、create table とは分けて書く
alter table public.services add column if not exists hosting  text[] not null default '{}';
alter table public.services add column if not exists database text[] not null default '{}';

comment on table  public.services is '作成したウェブサービスのマスタ。派生データ（GitHub、UptimeRobot）は持たない';
comment on column public.services.id is '通し番号。自動採番で、あとから変更できない';
comment on column public.services.description is '一言の説明。未設定なら GitHub のリポジトリ説明を使う';
comment on column public.services.github_repo is 'owner/repo の形';
comment on column public.services.url is 'サービスの URL。未設定なら GitHub の Website 欄を使う';
comment on column public.services.uptimerobot_monitor_id is 'UptimeRobot の monitor ID。未設定なら URL の一致で探す';
comment on column public.services.tags is '技術タグの追加分。GitHub の Topics と結合して表示する';
comment on column public.services.hosting is '配信先（GCE など）。空なら同期ジョブがサイトの応答とリポジトリから判定する';
comment on column public.services.database is 'DB（Cloud SQL など）。空なら同期ジョブがリポジトリから判定する';
comment on column public.services.released_on is '公開日。未設定なら GitHub の最初の Release の日付を使う';
comment on column public.services.note is '補足。一覧では行を展開したときだけ表示する';

-- updated_at を自動で更新し、id の変更を拒否する
create or replace function public.services_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id then
    raise exception 'services.id は変更できません（通し番号はマスタのキーです）';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists services_before_update on public.services;
create trigger services_before_update
  before update on public.services
  for each row execute function public.services_before_update();

-- RLS: 有効にしてポリシーは作らない。
-- anon キーからは何も読めず、同期ジョブは service_role キー（RLS を通過する）で読む。
alter table public.services enable row level security;
