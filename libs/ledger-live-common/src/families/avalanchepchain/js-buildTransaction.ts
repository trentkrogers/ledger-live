import type { Transaction } from "./types";
import { BN } from "avalanche";
import { avalancheClient, web3Client } from "./api/client";
import { HDHelper } from "./hdhelper";
import type { Account } from "../../types";
import { publicToAddress } from "ethereumjs-util";
import {
  TxHelper,
  GasHelper,
  getConfigFromUrl,
  setRpcNetwork,
  NetworkConfig,
  avalanche,
  bnToBigAvaxC,
  bigToBN,
  chainIdFromAlias,
} from "@avalabs/avalanche-wallet-sdk";
import { getEnv } from "../../env";
import { TestnetConfig } from "@avalabs/avalanche-wallet-sdk";
import { binTools } from "./utils";

const buildTransaction = async (
  account: Account,
  transaction: Transaction,
  hdHelper: HDHelper,
  ethPublicKey: string,
  evmAddress: string,
  hexAddress: string
) => {
  let unsignedTx;

  if (false) {
    const { amount } = transaction;

    const utxos = await hdHelper.fetchUTXOs();
    const returnAddress = hdHelper.getCurrentAddress();
    const pAddresses = hdHelper.getAllDerivedAddresses();
    const changeAddress = hdHelper.getFirstAvailableAddress();
    const nodeId = transaction.recipient;
    const startTime: BN = new BN(transaction.startTime?.toString());
    const endTime: BN = new BN(transaction.endTime?.toString());
    const stakeAmount: BN = transaction.useAllAmount
      ? new BN(account.spendableBalance.minus(transaction.fees || 0).toString())
      : new BN(amount.toString());

    //for testing
    //   const info = avalancheClient().Info();
    //   const nodeId = await info.getNodeID();
    //  const startTime: BN = UnixNow().add(new BN(FIVE_MINUTES));
    //   const endTime: BN = startTime.add(new BN(1814400)); //TODO: get this from UI
    //   console.log("UTXOs:", utxos);
    //   console.log("ADDRESSES: ", utxos.getAllUTXOStrings());

    const pChain = avalancheClient().PChain();

    unsignedTx = await pChain.buildAddDelegatorTx(
      utxos,
      [returnAddress],
      pAddresses,
      [changeAddress],
      nodeId,
      startTime,
      endTime,
      stakeAmount,
      [returnAddress]
    );
  }

  //else, is import / export
  //this won't exactly work--should have different build methdos for each mode

  if (transaction.mode === "c-to-p") {
    unsignedTx = await exportFromCChain(
      transaction,
      hdHelper,
      ethPublicKey,
      evmAddress,
      hexAddress
    );
  } else if (transaction.mode === "p-to-c") {
    unsignedTx = await exportFromPChain(transaction, evmAddress);
  }

  return unsignedTx;
};

const exportFromCChain = async (
  transaction,
  hdHelper,
  ethPublicKey,
  evmAddress,
  hexAddress
) => {
  const pChain = avalancheClient().PChain();

  let importFee = pChain.getTxFee();
  const amount = new BN(transaction.amount.toString());
  // const amount = new BN(101000000);
  importFee = new BN(importFee.toString());
  const totalAmount = amount.add(importFee);

  // console.log(totalAmount.toString());
  // const totalAmount = new BN(transaction.amount.toString()).add(
  //   importFee.toString()
  // );

  const bechAddress = evmAddress;

  const destinationAddress = hdHelper.getCurrentAddress();
  console.log("DESTINATION ADDRESS: ", destinationAddress);
  const destinationChain = "P";
  const exportFee = GasHelper.estimateExportGasFeeFromMockTx(
    destinationChain,
    new BN(amount),
    hexAddress,
    destinationAddress
  );
  const baseFee = await GasHelper.getBaseFeeRecommended();

  // console.warn("exportFee:", exportFee);
  // console.warn("baseFee:", baseFee.toString());
  const totalFee = bnToBigAvaxC(baseFee.mul(new BN(exportFee)));
  const totalFeeBN = bigToBN(totalFee, 9);
  // const totalFeeBN = new BN(350937);
  console.log("TOtal fee:", totalFeeBN.toString());

  // console.warn("intermediate fee:", baseFee.mul(new BN(exportFee)).toString());
  // console.warn("realTotalFee", realTotalFee.toString());
  // const test = bnToBigAvaxC(totalFee);

  // console.log("HEX ADDRESS: ", hexAddress);

  // const node = `${getEnv("API_AVALANCHE_NODE")}`;

  // const config = await getConfigFromUrl(node);

  // const node = `${getEnv("API_AVALANCHE_NODE")}`;

  // const config: NetworkConfig = {
  //   rawUrl: getEnv("API_AVALANCHE_NODE"),
  //   apiProtocol: "http",
  //   apiIp: "localhost",
  //   apiPort: 5555,
  //   networkID: 5,
  //   xChainID: "2JVSBoinj9C2J33VntvzYtVJNZdN2NKiwwKjcumHUWEb5DbBrm",
  //   pChainID: "11111111111111111111111111111111LpoYY",
  //   cChainID: "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp",
  //   evmChainID: 43113,
  //   avaxID: "U8iRqJoiJm8xZHAacmvYyZVwqQx6uDNtQeP3CQ6fcgQk3JqnK",
  //   rpcUrl: {
  //     c: "http://localhost:5555/ext/bc/C/rpc",
  //     p: "http://localhost:5555/ext/bc/P/rpc",
  //     x: "http://localhost:5555/ext/bc/X/rpc",
  //   },
  // };

  setRpcNetwork(TestnetConfig);
  //TODO: see why can't connect to node. put comment in FetchHTTPProvider.ts's send method

  // console.log("TestnetConfig: ", TestnetConfig);

  // console.log("CONFIG", config);

  const test = chainIdFromAlias("P");

  // let destinationChainId = avalancheClient().PChain().getBlockchainID();
  let destinationChainId = chainIdFromAlias(destinationChain);

  const nonce = await web3Client().eth.getTransactionCount(hexAddress);
  const avaxAssetIDBuffer = await avalancheClient().XChain().getAVAXAssetID();
  const avaxAssetIDString = binTools.cb58Encode(avaxAssetIDBuffer);

  // console.warn("CHAIN ID: ", test);
  // console.warn("OTHER CHAIN ID: ", destinationChainId);

  // console.log("HEX ADDRESS: ", hexAddress);
  // console.log("NONCE: ", nonce);
  // console.log("AVAX ASSET ID: ", avaxAssetIDString);

  // console.log("totalAmount: ", totalAmount);
  // console.log("avaxAssetIDString: ", avaxAssetIDString);
  // console.log("destinationChainId: ", destinationChainId);
  // console.log("hexAddress: ", hexAddress);
  // console.log("bechAddress: ", bechAddress);
  // console.log("destinationAddress: ", destinationAddress);
  // console.log("total Fee:", totalFeeBN);
  console.log("DESTINATION CHAIN ID: ", destinationChainId);

  // let destinationChainId = chainIdFromAlias(destinationChain);

  // const nonce = await web3.eth.getTransactionCount(fromAddresses[0]);
  // const avaxAssetIDBuf: Buffer = await xChain.getAVAXAssetID();
  // const avaxAssetIDStr: string = bintools.cb58Encode(avaxAssetIDBuf);

  // let fromAddressHex = fromAddresses[0];
  let fromAddressHex = hexAddress;

  console.log(
    amount.toString(),
    avaxAssetIDString,
    destinationChainId,
    fromAddressHex,
    bechAddress,
    ["P-fuji16klepv5njslwrvnrja30chu30az73qn6qq09wh"],
    nonce,
    totalFeeBN.toString()
  );

  const blockchainId = avalancheClient().CChain().getBlockchainID();
  // const refreshed = avalancheClient().CChain().refreshBlockchainID();

  console.log("BLOCKCHAIN ID LINE 205: ", blockchainId);
  // console.log("REFRESHED: ", refreshed);
  // console.log(
  //   "BLOCKCHAIN ID LINE 208: ",
  //   avalancheClient().CChain().getBlockchainID()
  // );

  const unsignedExportTx = await avalancheClient()
    .CChain()
    .buildExportTx(
      totalAmount,
      avaxAssetIDString,
      destinationChainId,
      fromAddressHex,
      bechAddress,
      ["P-fuji16klepv5njslwrvnrja30chu30az73qn6qq09wh"],
      nonce,
      undefined,
      undefined,
      totalFeeBN
    );

  // console.log("DESERIALIZED: ", asfd);

  //this gives same result as actual avalanche wallet, except off by EXACTLY one character
  // const unsignedExportTx = await TxHelper.buildEvmExportTransaction(
  //   [hexAddress],
  //   "P-fuji1e9ecz9eu0l07kaj5sn7gtslumpf0ms7f7fqy3d",
  //   amount,
  //   bechAddress,
  //   destinationChain,
  //   totalFeeBN
  // );

  console.log(
    "UNSIGNED TX BUFFER: ",
    unsignedExportTx.toBuffer().toString("hex")
  );

  return unsignedExportTx;

  // const tx = await this.signC(exportTx);
  // return this.issueC(tx);
};

const exportFromPChain = async (transaction, evmAddress) => {
  const hdHelper = HDHelper.getInstance();
  const utxoSet = await hdHelper.fetchUTXOs();
  const pChangeAddress = await hdHelper.getCurrentAddress();
  const pFromAddresses = await hdHelper.getAllDerivedAddresses();

  const importFee = GasHelper.estimateImportGasFeeFromMockTx(1, 1);
  const baseFee = await GasHelper.getBaseFeeRecommended();
  const totalFee = bnToBigAvaxC(baseFee.mul(new BN(importFee)));
  const totalFeeBN = bigToBN(totalFee, 9);

  const totalAmount = new BN(transaction.amount.toString()).add(totalFeeBN);

  const destinationAddress = evmAddress;
  const destinationChain = "C";
  const destinationBlockchainId = avalancheClient().CChain().getBlockchainID();

  console.log("DESTINATION CHAIN ID: ", destinationBlockchainId);

  console.log("TOTAL AMOUNT: ", totalAmount.toString());
  console.log("UTXO SET: ", utxoSet.getAddresses());

  const utxoAddrs = utxoSet
    .getAddresses()
    .map((addr) => binTools.addressToString("fuji", "P", addr));

  console.log("UTXO ADDRESSES: ", utxoAddrs);

  const test = await avalancheClient()
    .PChain()
    .buildExportTx(
      utxoSet,
      totalAmount,
      destinationBlockchainId,
      [destinationAddress],
      pFromAddresses,
      [pChangeAddress],
      undefined,
      undefined,
      undefined,
      undefined
    );

  return test;

  // const unsignedExportTx = await TxHelper.buildPlatformExportTransaction(
  //   utxoSet,
  //   pFromAddresses,
  //   destinationAddress,
  //   new BN(1000000),
  //   pChangeAddress,
  //   destinationChain
  // );

  return unsignedExportTx;
};

export default buildTransaction;
