-- Populate facilities.cluster from the State→Cluster→LGA→Facility grouping
-- (source: cluster_lga group.xlsx, 3 states / 9 clusters / 58 LGAs).
--
-- cluster is a pure function of LGA, so we set it per (state, lga) — this covers
-- all 281 facilities, including the 5 that are absent from the sheet but whose
-- LGAs are present. DB facility/LGA names are canonical; the sheet's spelling
-- and word-order variants (e.g. "Yakurr"→"Yakuur", hyphen vs space) are
-- reconciled here, not in the data.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260703_facilities_cluster.sql
-- Idempotent: re-running just re-sets the same values.

begin;

update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Abak';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Eastern Obolo';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Eket';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Esit Eket';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Essien Udim';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Etim Ekpo';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Etinan';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Ibeno';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Ibesikpo Asutan';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Ibiono-Ibom';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Ika';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Ikono';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Ikot Abasi';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Ikot Ekpene';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Ini';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Itu';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Mbo';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Mkpat-Enin';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Nsit-Atai';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Nsit-Ibom';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Nsit-Ubium';
update facilities set cluster = 'Ikot Ekpene' where state = 'Akwa Ibom' and lga = 'Obot Akara';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Okobo';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Onna';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Oron';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Oruk Anam';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Udung-Uko';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Ukanafun';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Uruan';
update facilities set cluster = 'Eket' where state = 'Akwa Ibom' and lga = 'Urue-Offong/Oruko';
update facilities set cluster = 'Uyo' where state = 'Akwa Ibom' and lga = 'Uyo';
update facilities set cluster = 'Central' where state = 'Cross River' and lga = 'Abi';
update facilities set cluster = 'Southern' where state = 'Cross River' and lga = 'Akamkpa';
update facilities set cluster = 'Southern' where state = 'Cross River' and lga = 'Akpabuyo';
update facilities set cluster = 'Southern' where state = 'Cross River' and lga = 'Bakassi';
update facilities set cluster = 'Central' where state = 'Cross River' and lga = 'Biase';
update facilities set cluster = 'Central' where state = 'Cross River' and lga = 'Boki';
update facilities set cluster = 'Southern' where state = 'Cross River' and lga = 'Calabar Municipal';
update facilities set cluster = 'Southern' where state = 'Cross River' and lga = 'Calabar South';
update facilities set cluster = 'Central' where state = 'Cross River' and lga = 'Ikom';
update facilities set cluster = 'Northern' where state = 'Cross River' and lga = 'Obanliku';
update facilities set cluster = 'Central' where state = 'Cross River' and lga = 'Obubra';
update facilities set cluster = 'Northern' where state = 'Cross River' and lga = 'Obudu';
update facilities set cluster = 'Southern' where state = 'Cross River' and lga = 'Odukpani';
update facilities set cluster = 'Northern' where state = 'Cross River' and lga = 'Ogoja';
update facilities set cluster = 'Central' where state = 'Cross River' and lga = 'Yakuur';
update facilities set cluster = 'Northern' where state = 'Cross River' and lga = 'Yala';
update facilities set cluster = 'Lagos West' where state = 'Lagos' and lga = 'Agege';
update facilities set cluster = 'Lagos West' where state = 'Lagos' and lga = 'Ajeromi-Ifelodun';
update facilities set cluster = 'Lagos Central' where state = 'Lagos' and lga = 'Apapa';
update facilities set cluster = 'Lagos West' where state = 'Lagos' and lga = 'Badagry';
update facilities set cluster = 'Lagos East' where state = 'Lagos' and lga = 'Ikorodu';
update facilities set cluster = 'Lagos East' where state = 'Lagos' and lga = 'Kosofe';
update facilities set cluster = 'Lagos Central' where state = 'Lagos' and lga = 'Lagos Island';
update facilities set cluster = 'Lagos Central' where state = 'Lagos' and lga = 'Lagos Mainland';
update facilities set cluster = 'Lagos West' where state = 'Lagos' and lga = 'Ojo';
update facilities set cluster = 'Lagos East' where state = 'Lagos' and lga = 'Shomolu';
update facilities set cluster = 'Lagos Central' where state = 'Lagos' and lga = 'Surulere';

-- Fail loudly if any facility was left without a cluster (a mis-keyed LGA).
do $$
declare n int;
begin
  select count(*) into n from facilities where cluster is null;
  if n > 0 then
    raise exception 'facilities.cluster still NULL for % row(s) — check LGA spellings', n;
  end if;
end $$;

commit;
