# Sending and receiving EDI

## The short answer

| Direction | How |
|---|---|
| **Send** | Logistics Pro renders the X12 (204, 210, 214, 990) and delivers it by the partner's chosen transport: **AS2** directly from the platform's central station, or a file handed to a **VAN or SFTP** gateway. JSON and XML partners get an HTTPS POST instead. |
| **Receive** | Partners send X12 to the central **AS2** station (`POST /as2`), or POST it over HTTPS with a per-partner token (`POST /v1/inbound/:org/:partner/edi`). Every inbound interchange is acknowledged with a **997**. |

## One central AS2 connection

The platform runs a single AS2 station, configured once by Logistics Pro:

| Setting | Where |
|---|---|
| AS2 id | `LP_AS2_ID` (default `LOGISTICSPRO`) |
| URL | `LP_PUBLIC_URL` + `/as2` |
| Certificate | `LP_AS2_KEY_PEM` / `LP_AS2_CERT_PEM`, or generated once and kept in `LP_AS2_DIR` |

A trading partner connects to that station **once** and can then exchange EDI with every business on Logistics Pro. Each business only fills in the partner's side on its partner profile (Integrations → partner → EDI → AS2):

1. The partner's **AS2 id**.
2. The partner's **AS2 URL**.
3. The partner's **public certificate** (PEM).

The business gives the partner our three values in return, shown under **Our AS2 station** in the app (and at `GET /as2/certificate`).

### What happens on the wire

- **Outbound:** the X12 is wrapped in MIME, signed (SHA-256 by default), encrypted to the partner's certificate (AES-256 by default), and POSTed. We request a **signed, synchronous MDN** (receipt) and accept the delivery only if the partner reports it processed and returns the same message integrity check (MIC) we computed. That proves they received exactly what we sent.
- **Inbound:** the station decrypts with its key, verifies the signature against the certificate the business recorded for that partner (certificates embedded in messages are never trusted), and answers with a signed MDN. Problems come back as MDN errors: `decryption-failed`, `integrity-check-failed`, `authentication-failed`, `insufficient-message-security`.
- **Routing:** the station finds the partner by `AS2-From`, then the business by the X12 interchange receiver id (ISA08). When several businesses trade with the same partner under the same id, the load number in the document decides. Inbound tenders (204) need a distinct id per business.
- **Acknowledgment:** the 997 is sent back as its own AS2 message right after the MDN.

### Compatibility

Supported: AES-256/192/128-CBC and 3DES encryption with RSA key transport; SHA-256/384/512 and SHA-1 signatures; signed or unsigned synchronous MDNs. These are the common AS2 1.2 profiles used by EDI gateways and VANs. Verified by tests both ways against OpenSSL: OpenSSL decrypts and verifies our messages, and we decrypt and verify messages OpenSSL produced.

Not yet supported: asynchronous MDNs, AS2 compression, RSASSA-PSS/RSA-OAEP, and certificate-exchange messages (CEM). Certificate rotation is manual: update the PEM on the partner profile, or replace the station key and share the new certificate with partners before switching.

### Going live with a partner

1. Exchange AS2 ids, URLs and certificates.
2. Set the partner profile's interchange ids (`EDI ids`) and pick AS2 for each EDI transaction.
3. Under **Integrations > partner > Onboarding**, **Send test messages**: each channel that goes to the partner gets a TEST document in test mode (ISA15 `T`). The partner's 997 marks each test acknowledged, and their replies to TEST shipments are recorded without touching real loads.
4. **Go live** once every item is done: usage switches to `P` (production). See [INTEGRATIONS.md](INTEGRATIONS.md#onboarding-a-partner).

Interchange and group control numbers come from a database sequence, so they never repeat across restarts or servers. Each inbound 997 is matched to the interchange it acknowledges, which is then marked acknowledged or rejected (with the partner's error) in the transmissions log.

## VAN and SFTP

For partners who require a VAN or SFTP, Logistics Pro writes each outbound interchange to `LP_EDI_OUTBOX/<van|sftp>/<partner>/` for your VAN client or SFTP job to pick up. Inbound files from those gateways can be posted to `POST /v1/inbound/:org/:partner/edi`.
