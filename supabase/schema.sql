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
alter table public.services add column if not exists infra text[] not null default '{}';
-- infra に 1 本化する前の列
alter table public.services drop column if exists hosting;
alter table public.services drop column if exists database;

comment on table  public.services is '作成したウェブサービスのマスタ。派生データ（GitHub、UptimeRobot）は持たない';
comment on column public.services.id is '通し番号。自動採番で、あとから変更できない';
comment on column public.services.description is '一言の説明。未設定なら GitHub のリポジトリ説明を使う';
comment on column public.services.github_repo is 'owner/repo の形';
comment on column public.services.url is 'サービスの URL。未設定なら GitHub の Website 欄を使う';
comment on column public.services.uptimerobot_monitor_id is 'UptimeRobot の monitor ID。未設定なら URL の一致で探す';
comment on column public.services.tags is '技術タグの追加分。GitHub の Topics と結合して表示する';
comment on column public.services.infra is 'インフラの追加分（GCE、Google Maps API など何でも）。同期ジョブの判定の結果に足す。-Name は判定の結果から除く';
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

-- ====================================================================
-- 区分、月ごとの費用と収益、キーの本数と期限
-- ここから下は足すだけで、上の列や表を消したり変えたりしない。
-- ====================================================================

-- 区分のマスタ。画面のコードには区分の一覧を書かず、この表から読む。
-- 区分を足すときや表示名を変えるときは、SQL Editor でこの表を直す（コードの変更は要らない）。
create table if not exists public.service_categories (
  key         text primary key check (key ~ '^[a-z0-9][a-z0-9-]*$'),
  label       text not null check (length(trim(label)) > 0),
  sort_order  integer not null default 0
);

comment on table  public.service_categories is 'サービスの区分（誰の名義の活動か）';
comment on column public.service_categories.key is '英小文字、数字、ハイフン。services.category と取り込みの JSON から参照する';
comment on column public.service_categories.sort_order is '画面に並べる順。小さいほうが先';

insert into public.service_categories (key, label, sort_order)
values
  ('personal',        '個人',           0),
  ('small-piece',     'Small Piece',    10),
  ('takatsu-connect', '高津コネクト',   20),
  ('machi-kikaku',    'まちの企画室',   30),
  ('kuroneko-taiwan', '黒猫台湾まつり', 40)
on conflict (key) do nothing;  -- すでにある行は変えない（あとから直した表示名を戻さない）

alter table public.services
  add column if not exists category text not null default 'personal'
  references public.service_categories (key) on update cascade;

comment on column public.services.category is '区分。service_categories.key を指す。既定は personal';

-- 月ごとの費用と収益。1 サービス 1 か月で 1 行。差し引きは保存せず、表示のときに計算する。
-- 書くのは取り込みのスクリプト（scripts/import-metrics.mjs）だけ。
create table if not exists public.service_monthly (
  service_id   bigint  not null references public.services (id) on delete cascade,
  month        date    not null check (extract(day from month) = 1),
  cost_jpy     integer not null default 0 check (cost_jpy >= 0),
  revenue_jpy  integer not null default 0 check (revenue_jpy >= 0),
  breakdown    jsonb,
  source       text,
  updated_at   timestamptz not null default now(),
  primary key (service_id, month)
);

comment on table  public.service_monthly is 'サービスごとの月の費用と収益（円）';
comment on column public.service_monthly.month is '月の 1 日で表す（2026-11 なら 2026-11-01）';
comment on column public.service_monthly.breakdown is '費用の内訳。名前から金額（円）への対応。合計は cost_jpy と一致させる';
comment on column public.service_monthly.source is '値の出どころ（取り込みの JSON の source）';

-- サービスに分けられない費用（組織やチームの単位で請求されるもの）。サービスには割り振らない。
create table if not exists public.shared_monthly_costs (
  month       date    not null check (extract(day from month) = 1),
  provider    text    not null check (length(trim(provider)) > 0),
  account     text    not null check (length(trim(account)) > 0),
  category    text    references public.service_categories (key) on update cascade,
  cost_jpy    integer not null check (cost_jpy >= 0),
  updated_at  timestamptz not null default now(),
  primary key (month, provider, account)
);

comment on table  public.shared_monthly_costs is 'サービスに分けられない月の費用（円）。画面では「共通の費用」として別に並べる';
comment on column public.shared_monthly_costs.provider is '請求元のサービス名';
comment on column public.shared_monthly_costs.account is '請求の単位（組織やチームの呼び名）';
comment on column public.shared_monthly_costs.category is '区分に寄せられるときだけ入れる';

-- キーの本数と、いちばん近い期限。1 サービス 1 行。置き場所や権限などの詳細は持たない。
create table if not exists public.service_keys (
  service_id      bigint primary key references public.services (id) on delete cascade,
  key_count       integer not null default 0 check (key_count >= 0),
  nearest_expiry  date,
  checked_at      timestamptz not null default now()
);

comment on table  public.service_keys is 'サービスが使う API キーの本数と、いちばん近い期限。詳細は載せない';
comment on column public.service_keys.nearest_expiry is '期限のあるキーがなければ null';
comment on column public.service_keys.checked_at is '台帳を確かめて取り込んだ日時';

-- どの表も services と同じく、RLS を有効にしてポリシーは作らない
alter table public.service_categories   enable row level security;
alter table public.service_monthly      enable row level security;
alter table public.shared_monthly_costs enable row level security;
alter table public.service_keys         enable row level security;

-- secret key（service_role）で読み書きできるようにする。既定の権限が付かないプロジェクトでも動かすため
grant select, insert, update, delete on
  public.service_categories,
  public.service_monthly,
  public.shared_monthly_costs,
  public.service_keys
to service_role;
