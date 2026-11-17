-- One database per project so schemas never collide. Test DBs are separate so
-- test runs can freely truncate tables.
CREATE DATABASE p03_job_queue;      CREATE DATABASE p03_job_queue_test;
CREATE DATABASE p04_webhooks;       CREATE DATABASE p04_webhooks_test;
CREATE DATABASE p06_saas;           CREATE DATABASE p06_saas_test;
CREATE DATABASE p07_object_store;   CREATE DATABASE p07_object_store_test;
CREATE DATABASE p08_collab;         CREATE DATABASE p08_collab_test;
CREATE DATABASE p09_payments;       CREATE DATABASE p09_payments_test;
CREATE DATABASE p10_workflows;      CREATE DATABASE p10_workflows_test;
