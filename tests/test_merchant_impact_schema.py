import sqlite3
from pathlib import Path

db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
db.executescript("""
CREATE TABLE merchants (id TEXT PRIMARY KEY);
CREATE TABLE transactions (id TEXT PRIMARY KEY);
INSERT INTO merchants(id) VALUES('MER-ONE'),('MER-TWO');
INSERT INTO transactions(id) VALUES('TX-1');
""")
sql = Path('migrations/0076_merchant_impact.sql').read_text()
db.executescript(sql)
db.execute("""INSERT INTO merchant_impact_policies
 (id,merchant_id,enabled,cause_code,contribution_mode,contribution_value,created_by)
 VALUES ('P1','MER-ONE',1,'REFORESTATION','BPS',25,'user1')""")
try:
    db.execute("""INSERT INTO merchant_impact_policies
     (id,merchant_id,enabled,cause_code,contribution_mode,contribution_value,created_by)
     VALUES ('P2','MER-ONE',0,'COMMUNITY_RELIEF','FLAT_CENTS',50,'user1')""")
    raise AssertionError('Multiple concurrent policies were accepted')
except sqlite3.IntegrityError:
    pass
db.execute("UPDATE merchant_impact_policies SET ended_at=CURRENT_TIMESTAMP WHERE id='P1'")
db.execute("""INSERT INTO merchant_impact_policies
 (id,merchant_id,enabled,cause_code,contribution_mode,contribution_value,created_by)
 VALUES ('P2','MER-ONE',0,'COMMUNITY_RELIEF','FLAT_CENTS',50,'user1')""")
db.execute("""INSERT INTO merchant_impact_commitments
(transaction_id,merchant_id,policy_id,transaction_amount_cents,payment_at)
VALUES('TX-1','MER-ONE','P1',50000,'2026-11-13T15:00:00Z')""")
db.execute("""INSERT INTO merchant_impact_valuations
(transaction_id,cumulative_refunded_cents,eligible_amount_cents,commitment_cents)
VALUES('TX-1',0,50000,125)""")
db.execute("""INSERT INTO merchant_impact_valuations
(transaction_id,cumulative_refunded_cents,eligible_amount_cents,commitment_cents)
VALUES('TX-1',20000,30000,75)""")
result = db.execute("SELECT commitment_cents FROM merchant_impact_current_valuations WHERE transaction_id='TX-1'").fetchone()
assert result == (75,), result
try:
    db.execute("""INSERT INTO merchant_impact_valuations
    (transaction_id,cumulative_refunded_cents,eligible_amount_cents,commitment_cents)
    VALUES('TX-1',20000,30000,75)""")
    raise AssertionError('Duplicate refund state was accepted')
except sqlite3.IntegrityError:
    pass
try:
    db.execute("UPDATE merchant_impact_valuations SET commitment_cents=99 WHERE transaction_id='TX-1'")
    raise AssertionError('Append-only safeguard failed')
except sqlite3.IntegrityError:
    pass
assert not db.execute("SELECT * FROM merchant_impact_funding_receipts").fetchall()
print('Impact D1 schema invariants: PASS')
