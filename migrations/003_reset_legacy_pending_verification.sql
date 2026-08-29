-- An earlier pre-release version of migration 002 grandfathered every pending
-- row. Reset only that exact legacy marker so pending users prove mailbox
-- ownership before an administrator can approve them.
UPDATE users
SET email_verified_at = NULL
WHERE role = 'staff'
  AND status = 'pending'
  AND email_verified_at = created_at;
