-- a ping per install per day for each version, loader version, workspace and user it ran as, and when it first pinged that way
create table pings_new (
  day text not null,
  install text not null,
  user text not null,
  team text not null,
  version text not null,
  loader text not null,
  loader_version text not null,
  embedded integer,
  os text,
  at text default (datetime()),
  primary key (install, day, user, team, version, loader_version)
);
insert into pings_new (day, install, user, team, version, loader, loader_version, embedded, os, at)
  select day, install, user, team, version, loader, loader_version, embedded, os, null from pings;
drop table pings;
alter table pings_new rename to pings;
create index pings_day on pings (day);
