-- Verification of the alert evaluator.
--
-- What is checked here is that each alert kind fires when it should, stays
-- silent when it should not, and that running the evaluator again -- which
-- production does every five minutes -- changes nothing.
--
-- How to run it:
--
--   npm run db:test
--
-- Run only against the disposable local database assembled by
-- scripts/local-supabase.mjs. Everything happens inside a transaction that ends
-- in ROLLBACK, so no workday, punch, alert or account link survives the test.
--
-- Why the workdays are inserted directly instead of going through punch():
-- punch() stamps the server's clock, and these checks need a workday that sits
-- at a chosen hour of a chosen day. The evaluator takes its instant as a
-- parameter for exactly this reason, so the suite pins both sides and nothing
-- depends on what time the test itself runs.
--
-- Why each phase uses its own date: the evaluator deliberately looks at the
-- previous local day as well as the current one, so consecutive dates would
-- bleed into each other. Every assertion is scoped to one employee, one date
-- and one kind.

begin;

create temporary table test_results (
  n        serial,
  name     text,
  expected text,
  got      text,
  passed   boolean
) on commit drop;

do $test$
declare
  v_emp1  uuid; v_emp2 uuid; v_dept1 uuid;
  v_uid1  uuid; v_uid2 uuid := gen_random_uuid();
  v_zone  text;
  v_today date;
  v_sched uuid;

  v_now     timestamptz;
  v_result  jsonb;
  v_details jsonb;
  v_count   integer;
  v_text    text;
  v_alert   uuid;
  v_late    boolean;

  d_a  date; d_b date; d_c date; d_c2 date; d_d date; d_e date;
  d_f  date; d_g date; d_h date; d_i date;  d_j date; d_k date;
  d_l  date; d_m date; d_n date;
begin
  select id into v_uid1 from auth.users order by created_at, id limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados
   where estado = 'activo' and id <> v_emp1 order by nombre limit 1;

  if v_uid1 is null or v_emp2 is null then
    raise exception 'Missing baseline data: need at least 1 account and 2 active employees';
  end if;

  -- The evaluator only looks at employees who can actually punch, so both need
  -- an account. The second one does not exist in the synthetic seed.
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_uid2, 'local.second@example.invalid', '{}'::jsonb);

  update public.empleados set auth_user_id = v_uid1 where id = v_emp1;
  update public.empleados set auth_user_id = v_uid2 where id = v_emp2;

  select department_id into v_dept1 from public.empleados where id = v_emp1;

  v_zone  := internal.time_zone_of(v_emp1);
  v_today := (now() at time zone v_zone)::date;

  -- The seeded global schedule starts the day the migration ran, which would
  -- leave every past date without a schedule. Pushing its start back is what
  -- lets the suite place scenarios on dates that are safely out of the way.
  update attendance.schedules
     set valid_from = v_today - 120
   where scope = 'global';

  -- The employee schedule under test covers all seven days, so no assertion
  -- depends on which day of the week the suite happens to run.
  insert into attendance.schedules (
    scope, employee_id, name, days,
    entry_from, entry_until, entry_expected, exit_expected,
    grace_minutes, break_max_minutes, valid_from
  )
  values (
    'employee', v_emp1, 'Test schedule', '{1,2,3,4,5,6,7}'::smallint[],
    '08:00', '09:30', '09:00', '18:00', 10, 60, v_today - 120
  )
  returning id into v_sched;

  d_a  := v_today - 3;
  d_b  := v_today - 6;
  d_c  := v_today - 9;
  d_c2 := v_today - 12;
  d_d  := v_today - 15;
  d_e  := v_today - 18;
  d_f  := v_today - 21;
  d_g  := v_today - 24;
  d_l  := v_today - 27;
  -- The most recent Saturday on or before that date: the global schedule runs
  -- Monday to Friday, so the second employee has no schedule at all that day.
  d_h  := (v_today - 30) - ((extract(isodow from (v_today - 30))::integer + 1) % 7);
  d_m  := v_today - 60;
  d_n  := v_today - 63;
  d_i  := v_today - 45;
  d_j  := v_today - 48;
  -- The most recent Monday, where the global schedule does apply.
  d_k  := (v_today - 51) - ((extract(isodow from (v_today - 51))::integer - 1) % 7);

  -- ================================================ PHASE A: missing_entry ===
  -- Nobody clocked in and the entry window closed at 09:30.

  v_now    := (d_a + time '10:00') at time zone v_zone;
  v_result := attendance.evaluate_alerts(v_now);

  select id, severity, details into v_alert, v_text, v_details
    from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_a and kind = 'missing_entry';

  insert into test_results(name, expected, got, passed) values
    ('missing_entry raised after the entry window closes', 'high',
     coalesce(v_text, 'no alert'), v_text = 'high');

  insert into test_results(name, expected, got, passed) values
    ('missing_entry counts the overdue minutes', '30',
     coalesce(v_details->>'minutes_overdue', 'no alert'),
     (v_details->>'minutes_overdue') = '30');

  -- Production runs this every five minutes. Twice must equal once.
  v_result := attendance.evaluate_alerts(v_now);
  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_a and kind = 'missing_entry';

  insert into test_results(name, expected, got, passed) values
    ('evaluating twice does not duplicate the alert', '1', v_count::text, v_count = 1);

  select count(*) into v_count from attendance.notification_outbox
   where alert_id = v_alert;

  insert into test_results(name, expected, got, passed) values
    ('one notification queued per alert, not per run', '1', v_count::text, v_count = 1);

  select o.payload->>'employee_name' into v_text
    from attendance.notification_outbox o where o.alert_id = v_alert;

  insert into test_results(name, expected, got, passed) values
    ('the notification carries what the sender needs',
     (select nombre from public.empleados where id = v_emp1),
     coalesce(v_text, 'no payload'),
     v_text = (select nombre from public.empleados where id = v_emp1));

  -- Once HR has acknowledged an alert, the evaluator must leave it alone.
  update attendance.alerts set state = 'acknowledged' where id = v_alert;
  v_result := attendance.evaluate_alerts(v_now);
  select state into v_text from attendance.alerts where id = v_alert;

  insert into test_results(name, expected, got, passed) values
    ('an acknowledged alert is never reopened', 'acknowledged',
     coalesce(v_text, 'gone'), v_text = 'acknowledged');

  -- =================================================== PHASE B: late_entry ===
  -- Expected at 09:00 with ten minutes of grace; arrived at 09:25.

  v_now := (d_b + time '10:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, last_heartbeat
  )
  values (
    v_emp1, d_b, 'working', v_sched, v_zone,
    (d_b + time '09:25') at time zone v_zone,
    v_now - interval '2 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_b and kind = 'late_entry';

  insert into test_results(name, expected, got, passed) values
    ('late_entry measures the delay past the grace period', '15',
     coalesce(v_details->>'minutes_late', 'no alert'),
     (v_details->>'minutes_late') = '15');

  select count(*), string_agg(kind, ',' order by kind) into v_count, v_text
    from attendance.alerts where employee_id = v_emp1 and alert_date = d_b;

  insert into test_results(name, expected, got, passed) values
    ('a late arrival raises nothing else', '1 late_entry',
     v_count || ' ' || coalesce(v_text, 'none'),
     v_count = 1 and v_text = 'late_entry');

  -- =============================================== PHASE C: break_exceeded ===
  -- Seventy-five minutes of break against an allowance of sixty and a
  -- threshold of five.

  v_now := (d_c + time '13:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, break_seconds, last_heartbeat
  )
  values (
    v_emp1, d_c, 'working', v_sched, v_zone,
    (d_c + time '09:00') at time zone v_zone, 75 * 60,
    v_now - interval '2 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_c and kind = 'break_exceeded';

  insert into test_results(name, expected, got, passed) values
    ('break_exceeded fires past the allowance', '75 of 60',
     coalesce((v_details->>'break_minutes') || ' of ' || (v_details->>'allowed_minutes'),
              'no alert'),
     (v_details->>'break_minutes') = '75' and (v_details->>'allowed_minutes') = '60');

  -- Sixty-two minutes is over the allowance but inside the threshold.
  v_now := (d_c2 + time '13:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, break_seconds, last_heartbeat
  )
  values (
    v_emp1, d_c2, 'working', v_sched, v_zone,
    (d_c2 + time '09:00') at time zone v_zone, 62 * 60,
    v_now - interval '2 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_c2 and kind = 'break_exceeded';

  insert into test_results(name, expected, got, passed) values
    ('a break inside the threshold stays silent', '0', v_count::text, v_count = 0);

  -- ================================================= PHASE D: missing_exit ===
  -- Expected out at 18:00, threshold sixty minutes, still open at 19:30.

  v_now := (d_d + time '19:30') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, last_heartbeat
  )
  values (
    v_emp1, d_d, 'working', v_sched, v_zone,
    (d_d + time '09:00') at time zone v_zone,
    v_now - interval '2 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_d and kind = 'missing_exit';

  insert into test_results(name, expected, got, passed) values
    ('missing_exit fires while the workday stays open', '90',
     coalesce(v_details->>'minutes_overdue', 'no alert'),
     (v_details->>'minutes_overdue') = '90');

  -- ================================================ PHASE E: no_connection ===
  -- The workday is open and the last heartbeat is half an hour old.

  v_now := (d_e + time '10:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, last_heartbeat
  )
  values (
    v_emp1, d_e, 'working', v_sched, v_zone,
    (d_e + time '09:00') at time zone v_zone,
    (d_e + time '09:30') at time zone v_zone
  );

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_e and kind = 'no_connection';

  insert into test_results(name, expected, got, passed) values
    ('no_connection fires on a silent open workday', '30',
     coalesce(v_details->>'minutes_silent', 'no alert'),
     (v_details->>'minutes_silent') = '30');

  -- The same silence during a sanctioned break is not a disconnection.

  v_now := (d_l + time '13:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, break_seconds, last_heartbeat
  )
  values (
    v_emp1, d_l, 'on_break', v_sched, v_zone,
    (d_l + time '09:00') at time zone v_zone, 10 * 60,
    v_now - interval '40 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select count(*), string_agg(kind, ',' order by kind) into v_count, v_text
    from attendance.alerts where employee_id = v_emp1 and alert_date = d_l;

  insert into test_results(name, expected, got, passed) values
    ('a silent break is not a disconnection', '0',
     v_count || ' ' || coalesce(v_text, ''), v_count = 0);

  -- =============================================== PHASE F: review_offline ===
  -- A punch that arrived flagged for review has to reach HR.

  v_now := (d_f + time '19:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, closed_at, last_heartbeat, has_offline, needs_review
  )
  values (
    v_emp1, d_f, 'finished', v_sched, v_zone,
    (d_f + time '09:00') at time zone v_zone,
    (d_f + time '18:00') at time zone v_zone,
    (d_f + time '18:00') at time zone v_zone,
    true, true
  );

  insert into attendance.punches (
    workday_id, employee_id, kind, occurred_at, client_reported_at,
    source, idempotency_key, needs_review, review_reason
  )
  select w.id, v_emp1, 'clock_in',
         (d_f + time '09:00') at time zone v_zone,
         (d_f + time '09:00') at time zone v_zone,
         'offline', gen_random_uuid(), true,
         'Reloj del equipo desviado 300 segundos respecto al servidor'
    from attendance.workdays w
   where w.employee_id = v_emp1 and w.work_date = d_f;

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_f and kind = 'review_offline';

  insert into test_results(name, expected, got, passed) values
    ('review_offline reports the flagged punch', '1',
     coalesce(v_details->>'punches_flagged', 'no alert'),
     (v_details->>'punches_flagged') = '1');

  -- =============================================== PHASE G: clock_tampered ===
  -- Twenty minutes of clock skew is past drift and into something else.

  v_now := (d_g + time '19:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, closed_at, last_heartbeat, has_offline
  )
  values (
    v_emp1, d_g, 'finished', v_sched, v_zone,
    (d_g + time '09:00') at time zone v_zone,
    (d_g + time '18:00') at time zone v_zone,
    (d_g + time '18:00') at time zone v_zone,
    true
  );

  insert into attendance.punches (
    workday_id, employee_id, kind, occurred_at, client_reported_at,
    source, idempotency_key, clock_skew_ms
  )
  select w.id, v_emp1, 'clock_in',
         (d_g + time '09:00') at time zone v_zone,
         (d_g + time '09:20') at time zone v_zone,
         'offline', gen_random_uuid(), 20 * 60 * 1000
    from attendance.workdays w
   where w.employee_id = v_emp1 and w.work_date = d_g;

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_g and kind = 'clock_tampered';

  insert into test_results(name, expected, got, passed) values
    ('clock_tampered reports the skew in minutes', '20',
     coalesce(v_details->>'skew_minutes', 'no alert'),
     (v_details->>'skew_minutes') = '20');

  -- ================================================== PHASE H: no schedule ===
  -- A Saturday for somebody the global weekday schedule does not cover. No
  -- schedule means no expectation, and no expectation means no alert.

  v_now    := (d_h + time '12:00') at time zone v_zone;
  v_result := attendance.evaluate_alerts(v_now);

  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp2 and alert_date = d_h;

  insert into test_results(name, expected, got, passed) values
    ('a day with no schedule raises nothing', '0', v_count::text, v_count = 0);

  -- ================================================ PHASE I: inactive rule ===

  update attendance.alert_rules
     set active = false
   where kind = 'review_offline' and department_id is null;

  v_now := (d_i + time '19:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, closed_at, last_heartbeat, has_offline, needs_review
  )
  values (
    v_emp1, d_i, 'finished', v_sched, v_zone,
    (d_i + time '09:00') at time zone v_zone,
    (d_i + time '18:00') at time zone v_zone,
    (d_i + time '18:00') at time zone v_zone,
    true, true
  );

  v_result := attendance.evaluate_alerts(v_now);

  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_i and kind = 'review_offline';

  insert into test_results(name, expected, got, passed) values
    ('an inactive rule silences its kind', '0', v_count::text, v_count = 0);

  -- ========================================= PHASE J: department precedence ===
  -- The same open workday as phase D, but this department is allowed four
  -- hours past the expected exit before anyone is told.

  insert into attendance.alert_rules (department_id, kind, active, threshold_minutes)
  values (v_dept1, 'missing_exit', true, 240);

  v_now := (d_j + time '19:30') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, last_heartbeat
  )
  values (
    v_emp1, d_j, 'working', v_sched, v_zone,
    (d_j + time '09:00') at time zone v_zone,
    v_now - interval '2 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_j and kind = 'missing_exit';

  insert into test_results(name, expected, got, passed) values
    ('a department threshold overrides the global one', '0', v_count::text, v_count = 0);

  -- ============================================== PHASE K: the account gate ===
  -- Somebody who cannot punch cannot be late. First the control, so that the
  -- silence afterwards means something.

  v_now    := (d_k + time '12:00') at time zone v_zone;
  v_result := attendance.evaluate_alerts(v_now);

  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp2 and alert_date = d_k and kind = 'missing_entry';

  insert into test_results(name, expected, got, passed) values
    ('an employee with an account is evaluated', '1', v_count::text, v_count = 1);

  delete from attendance.alerts where employee_id = v_emp2 and alert_date = d_k;
  update public.empleados set auth_user_id = null where id = v_emp2;

  v_result := attendance.evaluate_alerts(v_now);

  select count(*) into v_count from attendance.alerts
   where employee_id = v_emp2 and alert_date = d_k;

  insert into test_results(name, expected, got, passed) values
    ('an employee without an account raises nothing', '0', v_count::text, v_count = 0);

  -- ================================================== the return contract ===
  -- The evaluator reports what it did, which is what the cron log will show.

  insert into test_results(name, expected, got, passed) values
    ('the evaluator reports its own work', 'both counters present',
     coalesce(v_result->>'alerts_upserted', 'null') || '/' ||
     coalesce(v_result->>'notifications_queued', 'null'),
     (v_result->>'alerts_upserted') is not null
     and (v_result->>'notifications_queued') is not null
     and (v_result->>'evaluated_at') is not null);

  -- Every alert raised in this suite left exactly one queued notification.
  select count(*) into v_count
    from attendance.alerts a
    left join attendance.notification_outbox o on o.alert_id = a.id
   where a.employee_id in (v_emp1, v_emp2)
     and o.id is null;

  insert into test_results(name, expected, got, passed) values
    ('every alert leaves a queued notification', '0 without one',
     v_count || ' without one', v_count = 0);

  -- ================================================= PHASE L: early_exit ===
  -- Closed the day at 15:00 against an expected exit of 18:00. Three hours is
  -- well past the fifteen-minute default, and nothing described this before:
  -- `missing_exit` is the opposite case and requires the day to still be open.

  v_now := (d_m + time '19:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, closed_at, last_heartbeat
  )
  values (
    v_emp1, d_m, 'finished', v_sched, v_zone,
    (d_m + time '09:00') at time zone v_zone,
    (d_m + time '15:00') at time zone v_zone,
    (d_m + time '15:00') at time zone v_zone
  );

  v_result := attendance.evaluate_alerts(v_now);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_m and kind = 'early_exit';

  insert into test_results(name, expected, got, passed) values
    ('early_exit measures how long before the expected exit', '180',
     coalesce(v_details->>'minutes_early', 'no alert'),
     (v_details->>'minutes_early') = '180');

  insert into test_results(name, expected, got, passed) values
    ('and says which hour it compared against', '18:00',
     coalesce(v_details->>'expected_at', 'no alert'),
     (v_details->>'expected_at') = '18:00');

  -- The two exit rules require disjoint states, so a day can never collect
  -- both. A day that closed early is not a day somebody forgot to close.
  select count(*), string_agg(kind, ',' order by kind) into v_count, v_text
    from attendance.alerts where employee_id = v_emp1 and alert_date = d_m;

  insert into test_results(name, expected, got, passed) values
    ('leaving early raises nothing else, and never missing_exit', '1 early_exit',
     v_count || ' ' || coalesce(v_text, 'none'),
     v_count = 1 and v_text = 'early_exit');

  -- ============================== PHASE M: an alert whose evidence was voided ===
  -- The exact sequence that used to end in silence: arrive late, HR dismisses
  -- the alert, the day's punches are discarded, and the person clocks in late
  -- again. The unique key was already taken by a row the upsert would not
  -- touch, so the second arrival raised nothing at all.

  v_now := (d_n + time '10:00') at time zone v_zone;

  insert into attendance.workdays (
    employee_id, work_date, state, schedule_id, time_zone,
    opened_at, last_heartbeat
  )
  values (
    v_emp1, d_n, 'working', v_sched, v_zone,
    (d_n + time '09:30') at time zone v_zone,
    v_now - interval '2 minutes'
  );

  v_result := attendance.evaluate_alerts(v_now);

  select id into v_alert from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_n and kind = 'late_entry';

  select late into v_late
    from internal.resolved_days(array[v_emp1], d_n, d_n);

  insert into test_results(name, expected, got, passed) values
    ('the first late arrival marks the day late', 'true',
     coalesce(v_late::text, 'null'), v_late);

  -- HR decides it was nothing, and then the punches behind it are voided --
  -- which is what `reset_day()` does, spelled out here so this suite tests the
  -- evaluator rather than the writer.
  update attendance.alerts set state = 'dismissed' where id = v_alert;
  update attendance.alerts set superseded_at = now() where id = v_alert;

  select late into v_late
    from internal.resolved_days(array[v_emp1], d_n, d_n);

  insert into test_results(name, expected, got, passed) values
    ('an alert about a voided punch stops marking the day late', 'false',
     coalesce(v_late::text, 'null'), v_late is false);

  -- The day is punched again, later. This is the assertion the bug was.
  update attendance.workdays
     set opened_at = (d_n + time '11:00') at time zone v_zone
   where employee_id = v_emp1 and work_date = d_n;

  v_result := attendance.evaluate_alerts(v_now + interval '2 hours');

  select count(*)::integer into v_count from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_n and kind = 'late_entry';

  insert into test_results(name, expected, got, passed) values
    ('a superseded alert does not block its replacement', '2',
     v_count::text, v_count = 2);

  select details into v_details from attendance.alerts
   where employee_id = v_emp1 and alert_date = d_n and kind = 'late_entry'
     and superseded_at is null;

  insert into test_results(name, expected, got, passed) values
    ('and the live one describes the arrival that counts', '11:00',
     coalesce(v_details->>'arrived_at', 'no alert'),
     (v_details->>'arrived_at') = '11:00');

  -- The old row is still there. Nothing deletes here, and the dossier shows it.
  select state into v_text from attendance.alerts where id = v_alert;

  insert into test_results(name, expected, got, passed) values
    ('the superseded alert is kept, with the decision HR made on it', 'dismissed',
     coalesce(v_text, 'gone'), v_text = 'dismissed');

  -- ============================================================== restore ===
  update public.empleados set auth_user_id = null where id in (v_emp1, v_emp2);
end
$test$;

-- Readable report.
select n,
       name     as check_name,
       expected,
       got,
       case when passed then 'PASS' else '*** FAIL ***' end as verdict
  from test_results
 order by n;

-- If anything failed, blow up with a non-zero exit code so CI notices.
do $verdict$
declare
  v_failed int;
  v_total  int;
begin
  select count(*) filter (where passed is not true), count(*) into v_failed, v_total
    from test_results;

  if v_failed > 0 then
    raise exception '% of % checks failed', v_failed, v_total;
  end if;

  raise notice 'All % checks passed.', v_total;
end
$verdict$;

-- None of this sticks: not the schedules, not the workdays, not the alerts, not
-- the queued notifications, not the accounts used to satisfy the evaluator.
rollback;
