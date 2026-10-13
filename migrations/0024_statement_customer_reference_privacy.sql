PRAGMA foreign_keys = ON;

-- Routine emailed statements should identify a customer by the merchant's own reference,
-- or by the Builtegrity customer ID when the merchant has not supplied one. This prevents
-- the monthly statement renderer from falling through to the customer's personal name.
UPDATE customers
   SET merchant_customer_reference = id
 WHERE merchant_customer_reference IS NULL
    OR trim(merchant_customer_reference) = '';

CREATE TRIGGER IF NOT EXISTS customers_default_statement_reference_after_insert
AFTER INSERT ON customers
WHEN NEW.merchant_customer_reference IS NULL
  OR trim(NEW.merchant_customer_reference) = ''
BEGIN
  UPDATE customers
     SET merchant_customer_reference = NEW.id
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS customers_default_statement_reference_after_update
AFTER UPDATE OF merchant_customer_reference ON customers
WHEN NEW.merchant_customer_reference IS NULL
  OR trim(NEW.merchant_customer_reference) = ''
BEGIN
  UPDATE customers
     SET merchant_customer_reference = NEW.id
   WHERE id = NEW.id;
END;
