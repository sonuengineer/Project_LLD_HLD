# Learning Guide (Hinglish) -- Collaborative Editing

## Step 1: Problem samjho

Doc mein "ac" hai. Alice position 1 pe "X" daalti hai, Bob usi waqt position 1 pe "Y". Dono apne
screen pe change dekh chuke hain. Agar hum bas dono changes as-is apply karein, toh ek ke paas "aXYc"
aur doosre ke paas "aYXc" -- documents alag ho gaye. Collaborative editing ka core problem: concurrent
edits ke baad sabka document SAME hona chahiye (convergence).

## Step 2: Operational Transformation

`collab/ot.py`. Op = retain/insert/delete ki list. `transform(a, b)` do concurrent ops leta hai aur
(a', b') deta hai taaki "a phir b'" == "b phir a'". Tie (same position insert) mein a pehle.
`test_property_transform_converges`: 2000 random cases pe yeh property check hoti hai.

## Step 3: Central server kyun

Server har op ko ek revision number deta hai (Postgres row lock = ek document ke liye ek line).
Client ka op "maine rev 7 dekh ke yeh kiya" bolta hai; server rev 8, 9 ke against EK-EK karke
transform karta hai. Ek-ek kyun? `test_transform_does_not_distribute_over_compose` -- compose karke
transform karne se tie-break badal sakta hai. Sabko same sequence follow karna padta hai.

## Step 4: Client state machine

`collab/client.py`: outstanding (bheja, ack ka wait) + buffer (baad ke edits). Server ka op aaya ->
apne pending ops ke against transform karo, phir apply. Ack aaya -> buffer bhejo. Real bug: offline
client ke paas buffer tha par outstanding nahi -- humne buffer transform hi nahi kiya. Fuzz test ne
pakda. Lesson: random testing edge-case states dhoondh leta hai jo haath se likhe tests miss karte.

## Step 5: Reconnect aur lost ack

Op server pe apply ho gaya, ack aane se pehle connection toot gaya. Client ko lagta hai pending hai.
Reconnect: `last_rev` bhejo -> server missed ops bhejta hai (apna op ack ban ke aata hai). Agar client
phir bhi resend kar de toh `(client_id, client_seq)` UNIQUE constraint duplicate rok deta hai
(`test_lost_ack_resend_is_deduplicated`).

## Step 6: Multiple servers (horizontal scaling)

Alice server 1 pe, Bob server 2 pe. Op Postgres mein order hota hai, Redis pub/sub se dono servers ko
milta hai. Redis pub/sub at-most-once hai aur order guarantee nahi -> har server ka "ordered forwarder"
rev 5 se pehle 6 aaye toh 6 ko hold karta hai, aur 300ms tak gap rahe toh Postgres se missing rev padh
leta hai. Ack bhi isi ordered stream se jata hai.

## Step 7: Presence, cursors, history

Presence/cursors ephemeral hain -> Redis (DB nahi). History = op log + har 50 rev pe snapshot; kisi bhi
rev ka content = nearest snapshot + replay. Restore = naya op (history rewrite nahi hoti).

## Step 8: Security

WebSocket URL mein token daalna = logs mein token. Isliye one-time ticket (30s, GETDEL). Viewer ke ops
reject. Server har op validate karta hai (length match, size limits).

## Self-check

1. Convergence kya hai, OT kaise guarantee karta hai?
2. OT vs CRDT -- kab kya?
3. Server op ko history ke against one-by-one kyun transform karta hai?
4. Lost ack ke baad duplicate edit kaise ruka?
5. Redis pub/sub ki do kamzoriyan aur unka fix?
6. WebSocket servers horizontally scale karne mein kya problems aati hain?
7. Offline edits reconnect pe kaise merge hote hain?
8. Per-document throughput limit kyun hai aur kaise badhaoge?
