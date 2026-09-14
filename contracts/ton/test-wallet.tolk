tolk 1.4.2
// Restricted test fixture for TEP-74 transfer flows. Not official USD1.
struct Storage { balance: coins; owner: address; master: address; code: cell; pending: map<uint64, cell>; }
struct (0x0f8a7ea5) Transfer { queryId: uint64; amount: coins; destination: address; responseDestination: address; customPayload: cell?; forwardTonAmount: coins; forwardPayload: RemainingBitsAndRefs; }
struct (0x178d4519) InternalTransfer { queryId: uint64; amount: coins; from: address; response: address; forwardTonAmount: coins; forwardPayload: RemainingBitsAndRefs; }
struct (0x7362d09c) Notify { queryId: uint64; amount: coins; from: address; forwardPayload: RemainingBitsAndRefs; }
type Incoming = Transfer | InternalTransfer;
fun wallet(s: Storage, owner: address): AutoDeployAddress {
  return {workchain:0, stateInit:{code:s.code, data:Storage {balance:0, owner:owner, master:s.master, code:s.code,pending:[]}.toCell()}};
}
fun onInternalMessage(in: InMessage) {
  if (in.body.isEmpty()) { return; }
  var s = Storage.fromCell(contract.getData());
  val msg = lazy Incoming.fromSlice(in.body);
  match (msg) {
    Transfer => {
      assert(in.senderAddress == s.owner) throw 401;
      assert(msg.amount > 0 && msg.amount <= s.balance) throw 402;
      assert(in.valueCoins >= ton("0.08") && msg.forwardTonAmount >= ton("0.01") && msg.forwardTonAmount <= ton("0.02")) throw 403;
      assert(!s.pending.exists(msg.queryId)) throw 404;
      s.pending.set(msg.queryId,beginCell().storeCoins(msg.amount).storeAddress(wallet(s,msg.destination).calculateAddress()).endCell());
      s.balance -= msg.amount;
      createMessage({dest:wallet(s,msg.destination), value:ton("0.05"), bounce:BounceMode.Only256BitsOfBody,
        body:InternalTransfer {queryId:msg.queryId, amount:msg.amount, from:s.owner, response:msg.responseDestination,
        forwardTonAmount:msg.forwardTonAmount, forwardPayload:msg.forwardPayload}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
    InternalTransfer => {
      assert(in.senderAddress == s.master || in.senderAddress == wallet(s,msg.from).calculateAddress()) throw 401;
      assert(msg.amount > 0 && s.balance + msg.amount <= 18446744073709551615) throw 402;
      s.balance += msg.amount;
      if (msg.forwardTonAmount > 0) {
        createMessage({dest:s.owner, value:msg.forwardTonAmount, bounce:BounceMode.NoBounce,
          body:Notify {queryId:msg.queryId,amount:msg.amount,from:msg.from,forwardPayload:msg.forwardPayload}
        }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
      }
    }
    else => { throw 400; }
  }
  contract.setData(s.toCell());
}
fun onBouncedMessage(in: InMessageBounced) {
  var b = in.bouncedBody; b.skipBouncedPrefix();
  if (b.loadUint(32) != 0x178d4519) { return; }
  val q = b.loadUint(64);
  val amount = b.loadCoins();
  var s = Storage.fromCell(contract.getData());
  var expected = s.pending.mustGet(q).beginParse();
  assert(amount == expected.loadCoins() && in.senderAddress == expected.loadAddress()) throw 405;
  s.pending.delete(q); s.balance += amount;
  // Fixture-specific failure notification lets its escrow restore a failed release.
  createMessage({dest:s.owner,value:ton("0.01"),bounce:BounceMode.NoBounce,
    body:beginCell().storeUint(0x42524641,32).storeUint(q,64).storeCoins(amount).endCell()
  }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
  contract.setData(s.toCell());
}
get fun get_wallet_data(): (int, address, address, cell) { val s = Storage.fromCell(contract.getData()); return (s.balance,s.owner,s.master,s.code); }
