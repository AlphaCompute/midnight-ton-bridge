tolk 1.4.2

// One escrow per allowlisted reference-layout jetton. Fixed 2-of-3 Ed25519 committee.
struct Config { domain: uint256; keys: cell; master: address; walletCode: cell; cap: uint64; }
struct Recovery { nextRefund: uint64; refunds: map<uint64, cell>; pending: map<uint64, cell>; recovered: map<uint256, uint8>; }
struct Storage { config: Cell<Config>; locked: uint64; nextDeposit: uint64; nextRelease: uint64; recovery: Cell<Recovery>; deposits: map<uint64, cell>; releases: map<uint256, uint8>; }
struct (0x7362d09c) Deposit { queryId: uint64; amount: coins; from: address; payload: RemainingBitsAndRefs; }
struct Release { receipt: uint256; amount: uint64; recipient: address; a: uint8; b: uint8; sigA: cell; sigB: cell; }
struct (0x0f8a7ea5) Transfer { queryId: uint64; amount: coins; destination: address; responseDestination: address; customPayload: cell?; forwardTonAmount: coins; forwardPayload: RemainingBitsAndRefs; }


fun wallet(c: Config): address {
  val data = beginCell().storeCoins(0).storeAddress(contract.getAddress()).storeAddress(c.master).storeRef(c.walletCode).endCell();
  return AutoDeployAddress {workchain:0, stateInit: {code:c.walletCode, data:data}}.calculateAddress();
}

/// Committee member `i`'s Ed25519 public key.
fun committeeKey(c: Config, i: int): int { var k = c.keys.beginParse(); k.skipBits(i * 256); return k.loadUint(256); }
/// Signatures of committee members `a` and `b` (indices already validated) over `digest`.
fun assertQuorumSigned(c: Config, digest: int, a: int, b: int, sigA: cell, sigB: cell) {
  assert(isSignatureValid(digest, sigA.beginParse(), committeeKey(c, a))) throw 407;
  assert(isSignatureValid(digest, sigB.beginParse(), committeeKey(c, b))) throw 408;
}
/// Pays `amount` from the escrow's jetton wallet as outgoing query `q`. A bounce returns
/// through onBouncedMessage, which restores the pending entry.
fun sendTransfer(c: Config, q: int, amount: int, destination: address) {
  createMessage({dest:wallet(c),value:ton("0.1"),bounce:BounceMode.Only256BitsOfBody,
    body:Transfer {queryId:q,amount:amount as coins,destination:destination,responseDestination:contract.getAddress(),customPayload:null,forwardTonAmount:ton("0.01"),forwardPayload:beginCell().storeBool(false).endCell().beginParse()}
  }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
/// Records an exact refund to an authenticated sender. Refund and pending amounts are
/// coins-width, so any jetton amount (including one above the uint64 deposit ledger) can be
/// refunded; releases stay bounded by the uint64 `locked`.
fun recordRefund(mutate recovery: Recovery, id: int, amount: int, to: address) {
  recovery.refunds.set(id as uint64, beginCell().storeCoins(amount).storeAddress(to).endCell());
}
/// Undoes a failed outgoing transfer. Pending entry: (id, amount, isRelease, recipient);
/// for a refund the 256-bit id slot holds the uint64 refund id. A restored release clears
/// its replay marker, so the same signed release (fixed payee and amount) is valid again.
fun restorePending(mutate s: Storage, mutate recovery: Recovery, entry: cell) {
  var p = entry.beginParse(); val id = p.loadUint(256); val amount = p.loadCoins();
  if (p.loadBool()) { s.releases.delete(id); s.locked += amount; }
  else { recordRefund(mutate recovery, id, amount, p.loadAddress()); }
}

fun onInternalMessage(in: InMessage) {
  if (in.body.isEmpty()) { return; }
  var s = Storage.fromCell(contract.getData());
  var recovery = s.recovery.load();
  val c = s.config.load();
  val op = in.body.preloadUint(32);
  if (op == 0x7362d09c) {
      val msg = lazy Deposit.fromSlice(in.body);
      assert(in.senderAddress == wallet(c)) throw 401;
      assert(msg.amount > 0 && msg.from.getWorkchain() == 0) throw 402;
      var payload = msg.payload;
      // The cap is a uint64, so this also routes amounts above the deposit ledger to a refund.
      var valid = s.locked + msg.amount <= c.cap;
      var recipient = 0;
      if (payload.remainingBitsCount() < 1) { valid = false; }
      else {
        if (payload.loadBool()) {
          if (payload.remainingRefsCount() != 1 || payload.remainingBitsCount() != 0) { valid = false; }
          else { payload = payload.loadRef().beginParse(); }
        }
        if (payload.remainingBitsCount() == 256 && payload.remainingRefsCount() == 0) { recipient = payload.loadUint(256); }
        else { valid = false; }
      }
      if (valid) {
        val id = s.nextDeposit;
        s.deposits.set(id, beginCell().storeUint(msg.amount, 64).storeUint(recipient, 256).storeAddress(msg.from).endCell());
        s.nextDeposit += 1; s.locked += msg.amount;
      } else {
        // Unclaimable notification: record an exact refund to its authenticated
        // original sender. No committee can redirect it or select its amount.
        recordRefund(mutate recovery, recovery.nextRefund, msg.amount, msg.from);
        recovery.nextRefund += 1;
      }
  } else if (op == 0x42524704) {
      // Quorum attests a finalized downstream bounce returned funds to this wallet.
      // This only reopens an existing exact pending instruction; no arbitrary payout.
      var body = in.body; body.skipBits(32);
      val q = body.loadUint(64); val evidence = body.loadUint(256);
      val a = body.loadUint(8); val b = body.loadUint(8);
      val sigA = body.loadRef(); val sigB = body.loadRef(); body.assertEnd();
      assert(a < b && b < 3) throw 404;
      val pCell = recovery.pending.mustGet(q);
      val digest = beginCell().storeUint(op,32).storeAddress(contract.getAddress()).storeUint(c.domain,256)
          .storeRef(beginCell().storeUint(q,64).storeUint(evidence,256).storeRef(pCell).endCell()).endCell().hash();
      assertQuorumSigned(c, digest, a, b, sigA, sigB);
      recovery.pending.delete(q);
      restorePending(mutate s, mutate recovery, pCell);
  } else if (op == 0x42524705) {
      // Quorum attests a finalized jetton credit to this escrow's wallet whose notification
      // was never processed (missing or underfunded). It only creates an exact refund to
      // the authenticated original sender; each credit transaction is usable once.
      var body = in.body; body.skipBits(32);
      val evidence = body.loadUint(256); val amount = body.loadCoins(); val from = body.loadAddress();
      val a = body.loadUint(8); val b = body.loadUint(8);
      val sigA = body.loadRef(); val sigB = body.loadRef(); body.assertEnd();
      assert(a < b && b < 3) throw 404;
      assert(amount > 0 && from.getWorkchain() == 0) throw 402;
      assert(!recovery.recovered.exists(evidence)) throw 406;
      val digest = beginCell().storeUint(op,32).storeAddress(contract.getAddress()).storeUint(c.domain,256)
          .storeRef(beginCell().storeUint(evidence,256).storeCoins(amount).storeAddress(from).endCell()).endCell().hash();
      assertQuorumSigned(c, digest, a, b, sigA, sigB);
      recovery.recovered.set(evidence, 1);
      recordRefund(mutate recovery, recovery.nextRefund, amount, from);
      recovery.nextRefund += 1;
  } else if (op == 0x42524703) {
      assert(in.valueCoins >= ton("0.15")) throw 403;
      var request = in.body; request.skipBits(32); val id = request.loadUint(64); request.assertEnd();
      var refund = recovery.refunds.mustGet(id).beginParse(); val amount = refund.loadCoins(); val recipient = refund.loadAddress();
      recovery.refunds.delete(id); val q = s.nextRelease; s.nextRelease += 1;
      recovery.pending.set(q,beginCell().storeUint(id,256).storeCoins(amount).storeBool(false).storeAddress(recipient).endCell());
      sendTransfer(c, q, amount, recipient);
  } else if (op == 0x42524701) {
      var body = in.body; body.skipBits(32);
      val msg = lazy Release.fromSlice(body);
      assert(in.valueCoins >= ton("0.15")) throw 403;
      assert(msg.recipient.getWorkchain() == 0) throw 411;
      assert(msg.a < msg.b && msg.b < 3) throw 404;
      assert(msg.amount > 0 && s.locked >= msg.amount) throw 405;
      assert(!s.releases.exists(msg.receipt)) throw 406;
      val digest = beginCell().storeUint(op, 32).storeAddress(contract.getAddress()).storeUint(c.domain, 256)
        .storeRef(beginCell().storeUint(msg.receipt, 256).storeUint(msg.amount, 64).storeAddress(msg.recipient).endCell()).endCell().hash();
      assertQuorumSigned(c, digest, msg.a, msg.b, msg.sigA, msg.sigB);
      val q = s.nextRelease;
      s.nextRelease += 1;
      s.releases.set(msg.receipt, 1); // submitted; NOT an assertion of recipient delivery
      recovery.pending.set(q, beginCell().storeUint(msg.receipt, 256).storeCoins(msg.amount as coins).storeBool(true).endCell());
      s.locked -= msg.amount;
      sendTransfer(c, q, msg.amount, msg.recipient);
  } else if (op == 0xd53276db) { return; } else { throw 400; }
  s.recovery = recovery.toCell();
  contract.setData(s.toCell());
}

fun onBouncedMessage(in: InMessageBounced) {
  var s = Storage.fromCell(contract.getData());
  var recovery = s.recovery.load();
  assert(in.senderAddress == wallet(s.config.load())) throw 401;
  var b = in.bouncedBody;
  b.skipBouncedPrefix();
  if (b.loadUint(32) != 0x0f8a7ea5) { return; }
  val q = b.loadUint(64);
  val entry = recovery.pending.get(q);
  assert(entry.isFound) throw 409;
  recovery.pending.delete(q);
  restorePending(mutate s, mutate recovery, entry.loadValue());
  s.recovery = recovery.toCell();
  contract.setData(s.toCell());
}
get fun locked(): int { return Storage.fromCell(contract.getData()).locked; }
get fun depositCount(): int { return Storage.fromCell(contract.getData()).nextDeposit; }
get fun deposit(id: uint64): cell { return Storage.fromCell(contract.getData()).deposits.mustGet(id); }
get fun releaseState(id: uint256): int { val s = Storage.fromCell(contract.getData()); return s.releases.exists(id) ? s.releases.mustGet(id) : 0; }

get fun refundCount(): int { return Storage.fromCell(contract.getData()).recovery.load().nextRefund; }
get fun refund(id: uint64): cell { return Storage.fromCell(contract.getData()).recovery.load().refunds.mustGet(id); }

get fun pending(id: uint64): cell { return Storage.fromCell(contract.getData()).recovery.load().pending.mustGet(id); }
get fun recovered(evidence: uint256): int { return Storage.fromCell(contract.getData()).recovery.load().recovered.exists(evidence) ? 1 : 0; }
get fun nextRelease(): int { return Storage.fromCell(contract.getData()).nextRelease; }
