-- OAuth identity bindings for the MCP endpoint.
--
-- A binding is a credential row of kind 'oauth'. Its token_digest is an HMAC
-- (under TOKEN_PEPPER) of the validated issuer and subject, so external
-- account identifiers are never stored in plain text. Because bindings are
-- credentials, revocation, the admission guard's access check, and listing
-- all work unchanged. Bearer tokens ('token') stay agent-only; an 'oauth'
-- binding may name the owner participant, created only through the owner API.
ALTER TABLE credentials ADD COLUMN kind TEXT NOT NULL DEFAULT 'token' CHECK (kind IN ('token', 'oauth'));
