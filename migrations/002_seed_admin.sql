-- Demo admin with a fixed id, so admin endpoints can be tried right away:
--   x-user-id: 00000000-0000-0000-0000-00000000ad01
-- POST /users only creates normal users; admins would come from the identity provider.
INSERT INTO users (id, display_name, role)
VALUES ('00000000-0000-0000-0000-00000000ad01', 'Demo Admin', 'admin');

INSERT INTO accounts (type, owner_id, normal_side, allow_negative) VALUES
    ('USER_WALLET',      '00000000-0000-0000-0000-00000000ad01', 'CREDIT', FALSE),
    ('CREATOR_EARNINGS', '00000000-0000-0000-0000-00000000ad01', 'CREDIT', TRUE);
