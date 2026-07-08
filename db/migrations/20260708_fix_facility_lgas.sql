-- Correct the LGA (and matching cluster) for two Akwa Ibom facilities.
--   Ekpene Obom QIC Rehabilitation Hospital: Esit Eket  -> Etinan       (cluster Eket -> Uyo)
--   Ikpe Annang General Hospital:            Ikot Ekpene -> Essien Udim (cluster stays Ikot Ekpene)
--
-- Matched by name (ids differ per environment). The Ekpene Obom name is stored
-- truncated on some DBs ("…Hosp"), so a prefix match covers both forms. Raises if
-- a facility isn't found, so a name mismatch on prod fails loudly instead of
-- silently doing nothing. Idempotent. Run manually on prod.

do $$
declare n1 int; n2 int;
begin
  update facilities set lga = 'Etinan', cluster = 'Uyo'
   where state = 'Akwa Ibom' and name like 'Ekpene Obom QIC Rehabilitation Hosp%';
  get diagnostics n1 = row_count;

  update facilities set lga = 'Essien Udim', cluster = 'Ikot Ekpene'
   where state = 'Akwa Ibom' and name = 'Ikpe Annang General Hospital';
  get diagnostics n2 = row_count;

  if n1 = 0 then raise exception 'Ekpene Obom QIC Rehabilitation Hospital not found — check the stored name on this DB'; end if;
  if n2 = 0 then raise exception 'Ikpe Annang General Hospital not found — check the stored name on this DB'; end if;
  raise notice 'LGA fix applied — Ekpene Obom: % row(s) -> Etinan/Uyo; Ikpe Annang General: % row(s) -> Essien Udim/Ikot Ekpene', n1, n2;
end $$;
