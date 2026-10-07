# Documents and delivery signatures

Load paperwork lives on the load, where the driver, the carrier's office, and the shipper or broker can all open it. Invoices carry it automatically.

## Scanning

On the load page, under **Documents**, pick the kind (bill of lading, POD, lumper receipt, scale ticket, other), then:

- **Scan with camera**: take a photo of the page and crop it to the edges. The app shrinks it to a sharp, readable JPEG of at most 1,800 pixels on the long side before uploading, so it goes through on a weak signal.
- **Choose photo**: a picture already on the phone.
- **Attach PDF**: an emailed BOL or receipt.

On the website, the photo button opens the browser's file picker, which offers the camera on phones and tablets.

A BOL is filed against the pickup stop and a POD against the delivery. Each upload is posted to the load's message thread.

## Delivery signature

At delivery the driver taps **Get delivery signature** and hands over the phone. The receiver enters their name, the pieces received and any shortage or damage, and signs in the box. Logistics Pro draws the signed receipt on the server and files it as the load's POD, with the time and the phone's location. If the load is at delivery, the app then offers to mark it delivered.

The receipt is drawn from the signature's pen strokes, not from anything the phone renders, so it can't carry hidden content.

If a delivered load has no POD, the driver who delivered it sees **Add the POD** on Today until one is added.

## Storage and access

| Setting | Where files go |
|---|---|
| `LP_DATABASE_URL` set | In Postgres (`lp_files`), so every API server can serve every file |
| `LP_FILES_DIR` set, no database | One file per document in that directory |
| Neither | In memory, lost on restart (development only) |

Uploads are JPEG, PNG, WebP or PDF, up to 10 MB. The server checks the file's first bytes match its declared type. Files are served only to people who can see the load, or through a link signed for one hour that the app uses for thumbnails and opening files in a new tab. They are served with `nosniff` and a content security policy that blocks scripts.

API: `POST /v1/loads/:id/documents/upload`, `POST /v1/loads/:id/pod`, `GET /v1/files/:id`.

## Limits

- Scanning is a cropped photo, not edge detection and de-skewing. A native document scanner (VisionKit on iOS, ML Kit on Android) would sharpen it and needs a development build.
- One page per upload; multi-page paperwork is uploaded page by page.
- Documents aren't sent in EDI 210 invoices; the customer opens them in the app or through the API.
