# Learning Guide (Hinglish) -- Object Storage

## Step 1: Object storage hai kya

File system mein folders hote hain, files edit hoti hain. Object storage mein bucket + key + bytes:
pura object replace hota hai, beech mein edit nahi. "docs/a.txt" ek single key hai -- folder sirf
listing ka illusion hai (`delimiter=/` se common prefixes banate hain). S3, backups, images, data lake.

## Step 2: Metadata aur bytes alag

`services/objects.py` docstring. Postgres mein naam, versions, permissions; bytes storage adapter mein
random blob key ke naam se. Key se file path kabhi nahi banta -> `../../etc/passwd` sirf ek string hai
(`test_hostile_keys_never_touch_filesystem_paths`).

Write ka order important: pehle bytes, phir metadata commit. Beech mein crash = orphan blob (GC saaf
karega). Ulta order hota toh metadata ek aise blob ko point karta jo exist hi nahi karta -- bahut bura.

## Step 3: Integrity -- checksums

Upload stream karte waqt MD5 + SHA-256 calculate hote hain (`storage/base.py::HashingStream`). Client
ne Content-MD5 bheja aur match nahi hua -> 400 BadDigest. Signed request mein body ka hash bhi signature
mein hai -> beech wala proxy body badle toh pakda jayega (`test_signed_body_cannot_be_swapped`).

## Step 4: Versioning

Enabled bucket mein har PUT naya version. DELETE = "delete marker" (data abhi bhi hai!). Marker
version delete karo -> purana object wapas (undelete). Database guarantee: ek key ka sirf ek latest
version (partial unique index) -- 20 parallel PUTs ke baad bhi.

## Step 5: Multipart upload

5GB file ek request mein bhejoge aur 99% pe network gaya -> sab dobara. Multipart: chhote parts, har
part alag upload/retry, phir complete. Gotcha: multipart ETag = md5(sab parts ke md5) + "-N", poore
object ka MD5 NAHI (`test_multipart_upload`).

## Step 6: Presigned URLs

Browser ko apna secret nahi de sakte. Server ek URL banata hai jisme method, key, expiry sign ho
chuke hain -> 10 minute tak sirf yeh ek file GET kar sakte ho. Method badla, key badli, time nikla
-> 401 (`test_presigned_urls`). Rule: wahi presign kar sakte ho jo khud kar sakte ho.

## Step 7: Request signing (SigV4 jaisa)

Secret network pe kabhi nahi jata. Method + path + query + date + body hash ka HMAC. Date 15 minute ke
andar honi chahiye (replay protection).

## Step 8: Lifecycle aur GC

Logs 30 din baad expire, purane versions 7 din baad, adhoore multipart uploads 1 din baad abort.
Noncurrent age naye version ke created time se ginte hain (window function `lag`). GC: queued deletions
+ orphan blobs, lekin grace period ke saath taaki in-flight upload delete na ho.

## Step 9: Performance story

Har PUT bucket row lock le raha tha -> bucket ke saare writes ek line mein. Lock sirf quota wale bucket
pe. Phir measure kiya: concurrency 4 ke baad process CPU-bound (CPU 110-122% of wall) -> API stateless
hai, toh horizontally scale karo.

## Self-check

1. Object vs file vs block storage?
2. Blob key random kyun? Path traversal kaise ruka?
3. Bytes pehle ya metadata pehle -- kyun?
4. Delete marker kya hai, undelete kaise?
5. Multipart ETag MD5 kyun nahi hota?
6. Presigned URL leak ho jaye toh blast radius?
7. Quota versioned bucket mein kaise count hota hai?
8. GC grace period kyun?
