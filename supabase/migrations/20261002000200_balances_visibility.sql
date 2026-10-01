-- Owner decision 1 ต.ค. 69: เป้อ (manager) and นุ้ย (finance_field) see the balance of every wallet.
drop policy money_read on ledger_entries;
create policy money_read on ledger_entries for select to authenticated
  using (my_role() in ('ceo', 'finance', 'finance_field', 'manager', 'auditor'));
drop policy money_read on bank_checks;
create policy money_read on bank_checks for select to authenticated
  using (my_role() in ('ceo', 'finance', 'finance_field', 'manager', 'auditor'));
