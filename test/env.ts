// Test environment. Imported first by each test file, before any src module reads config.
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/test";
process.env.DATABASE_SSL ??= "false";
process.env.BASE_URL = "http://localhost:0";
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.OWNER_EMAILS = "owner@example.com";
process.env.ENCRYPTION_KEY = "test-encryption-key-that-is-long-enough-123";
process.env.FORWARD_ALLOWLIST = "agent@example.org";
