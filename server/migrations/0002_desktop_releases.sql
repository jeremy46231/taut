create table desktop_releases (
  version text primary key,
  assets text not null,
  platforms text not null,
  feeds text not null,
  updated text not null
);
