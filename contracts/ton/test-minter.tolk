tolk 1.4.2
struct Storage { owner: address; walletCode: cell; supply: uint64; cap: uint64; }
struct (0x4d494e54) Mint { recipient: address; amount: uint64; }
struct (0x178d4519) InternalTransfer { queryId:uint64; amount:coins; from:address; response:address; forwardTonAmount:coins; forwardPayload:RemainingBitsAndRefs; }
fun onInternalMessage(in: InMessage) {
  if (in.body.isEmpty()) { return; }
  var s = Storage.fromCell(contract.getData());
  val m = Mint.fromSlice(in.body);
  assert(in.senderAddress == s.owner && in.valueCoins >= ton("0.1")) throw 401;
  assert(m.amount > 0 && s.supply + m.amount <= s.cap) throw 402;
  s.supply += m.amount;
  val data = beginCell().storeCoins(0).storeAddress(m.recipient).storeAddress(contract.getAddress()).storeRef(s.walletCode).storeBool(false).endCell();
  createMessage({dest:AutoDeployAddress {workchain:0,stateInit:{code:s.walletCode,data:data}},value:ton("0.08"),bounce:BounceMode.Only256BitsOfBody,
    body:InternalTransfer {queryId:0,amount:m.amount as coins,from:contract.getAddress(),response:s.owner,forwardTonAmount:0,
    forwardPayload:beginCell().storeBool(false).endCell().beginParse()}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
  contract.setData(s.toCell());
}
get fun get_jetton_data(): (int, int, address, cell, cell) { val s = Storage.fromCell(contract.getData()); return (s.supply,-1,s.owner,beginCell().endCell(),s.walletCode); }
