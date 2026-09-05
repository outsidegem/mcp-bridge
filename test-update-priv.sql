CREATE TABLE t (id INT, secret INT, state TEXT);
INSERT INTO t VALUES (1, 123, 'A');
CREATE ROLE test_u NOLOGIN;
GRANT UPDATE (state) ON t TO test_u;
SET ROLE test_u;
UPDATE t SET state = 'B' WHERE secret = 123;
