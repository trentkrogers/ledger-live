import { Observable } from "rxjs";
import { BigNumber } from "bignumber.js";
import type { Transaction } from "./types";
import type {
  Operation,
  Account,
  SignOperationEvent,
  OperationType,
} from "../../types";
import { withDevice } from "../../hw/deviceAccess";
import buildTransaction from "./js-buildTransaction";
import Avalanche, { AVAX_BIP32_PREFIX } from "./hw-app-avalanche";
import { encodeOperationId } from "../../operation";
import { binTools } from "./utils";
import { Buffer as AvalancheBuffer, BN } from "avalanche";
import {
  TransferableOperation,
  UnsignedTx as AVMUnsignedTx,
  ImportTx as AVMImportTx,
  AVMConstants,
} from "avalanche/dist/apis/avm";
import { OperationTx } from "avalanche/dist/apis/avm";
import {
  UnsignedTx as EVMUnsignedTx,
  ImportTx as EVMImportTx,
  ExportTx as EVMExportTx,
  Tx as EvmTx,
  EVMConstants,
  EVMInput,
  SelectCredentialClass as EVMSelectCredentialClass,
  UTXOSet as EVMUTXOSet,
} from "avalanche/dist/apis/evm";
import {
  ExportChainsC,
  ExportChainsP,
  ExportChainsX,
  UtxoHelper,
  TxHelper,
  GasHelper,
  chainIdFromAlias,
  xChain,
  avalanche,
  bnToBigAvaxC,
  bigToBN,
} from "@avalabs/avalanche-wallet-sdk";

import { Credential, SigIdx, Signature } from "avalanche/dist/common";
import {
  Tx as PlatformTx,
  UnsignedTx as PlatformUnsignedTx,
  SelectCredentialClass as PlatformSelectCredentialClass,
  ImportTx as PlatformImportTx,
  ExportTx as PlatformExportTx,
  UTXO as PlatformUTXO,
  PlatformVMConstants,
  AddDelegatorTx,
  AddValidatorTx,
} from "avalanche/dist/apis/platformvm";
import BIPPath from "bip32-path";
import { HDHelper } from "./hdhelper";
import { createHash } from "crypto";
import { AVAX_HRP } from "./utils";
import Eth from "@ledgerhq/hw-app-eth";
import HDKey from "hdkey";
import { avalancheClient } from "./api/client";
import { importPublic, publicToAddress } from "ethereumjs-util";
import { Tx as EVMTx } from "avalanche/dist/apis/evm/tx";
import { setTimeout } from "timers/promises";

const STAKEABLELOCKINID: number = 21;
const ETH_PATH = "44'/60'/0'/0/0";
const ETH_BIP32_PREFIX = "m/44'/60'/0'";
const IMPORT_DELAY = 5000;

//TODO: fix this, not good practice
let evmAddress;
let hexAddress;

const signOperation = ({
  account,
  deviceId,
  transaction,
}: {
  account: Account;
  deviceId: any;
  transaction: Transaction;
}): Observable<SignOperationEvent> =>
  withDevice(deviceId)(
    (transport) =>
      new Observable<SignOperationEvent>((o) => {
        let cancelled;

        async function main() {
          const publicKey = account.avalanchePChainResources?.publicKey ?? "";
          const chainCode = account.avalanchePChainResources?.chainCode ?? "";

          console.warn("INSIDE SIGN OPERATION");

          const hdHelper = await HDHelper.instantiate(publicKey, chainCode);

          const eth: Eth = new Eth(transport);
          const { publicKey: ethPublicKey, chainCode: ethChainCode } =
            await eth.getAddress(ETH_PATH, false, true);

          const hdEth = new HDKey();
          hdEth.publicKey = Buffer.from(ethPublicKey, "hex");
          hdEth.chainCode = Buffer.from(ethChainCode as string, "hex");

          evmAddress = binTools.addressToString(
            AVAX_HRP,
            "C",
            // @ts-ignore
            hdEth.pubKeyHash
          );
          const ethPublic = importPublic(hdEth.publicKey);
          // console.warn("HD ETH PUB KEY: ", hdEth.publicKey);
          // console.warn("ETH PUBLIC: ", ethPublic);
          hexAddress = publicToAddress(ethPublic).toString("hex");

          // console.log("HEX ADDRESS AFTER PUBLIC TO ADDRESS: ", hexAddress);

          let unsignedTx;
          unsignedTx = await buildTransaction(
            account,
            transaction,
            hdHelper,
            ethPublicKey,
            evmAddress,
            hexAddress
          );

          const avalanche: Avalanche = new Avalanche(transport);

          console.error("mode: ", transaction.mode);
          if (transaction.mode == "c-to-p") {
            const tx = await signC(unsignedTx as EVMUnsignedTx, avalanche);
            console.warn("PAST SIGNING");
            const txId = await issueC(tx);
            console.warn("PAST ISSUING: ", txId);
            const result = await waitExportStatus(txId, "C", avalanche);
          } else if (transaction.mode == "p-to-c") {
            const tx = await signP(unsignedTx as PlatformUnsignedTx, avalanche);
            console.warn("PAST SIGNING");
            const txId = await issueP(tx);
            console.warn("PAST ISSUING: ", txId);
            const result = await waitExportStatus(txId, "P", avalanche);
          } else {
            const chainId = "P";
            const extendedPAddresses = hdHelper.getExtendedAddresses();
            const { paths, addresses } = getTransactionPathsAndAddresses(
              unsignedTx,
              chainId,
              extendedPAddresses
            );

            const config = await avalanche.getLedgerAppConfiguration();
            let canLedgerParse = getCanLedgerParse(config, unsignedTx);

            o.next({ type: "device-signature-requested" });

            let signedTx: PlatformTx;

            if (canLedgerParse) {
              signedTx = await signTransactionParsable<
                PlatformUnsignedTx,
                PlatformTx
              >(unsignedTx, paths, chainId, avalanche);
            } else {
              signedTx = await signTransactionHash<
                PlatformUnsignedTx,
                PlatformTx
              >(unsignedTx, paths, chainId, avalanche);
            }

            if (cancelled) return;

            o.next({ type: "device-signature-granted" });

            const signature =
              "0x" + binTools.addChecksum(signedTx.toBuffer()).toString("hex");

            const operation = buildOptimisticOperation(account, transaction);

            o.next({
              type: "signed",
              signedOperation: {
                operation,
                signature,
                expirationDate: null,
              },
            });
          }
        }

        main().then(
          () => o.complete(),
          (e) => o.error(e)
        );
        return () => {
          cancelled = true;
        };
      })
  );

const signC = async (unsignedTx: EVMUnsignedTx, avalanche): Promise<EvmTx> => {
  // TODO: Might need to upgrade paths array to:
  //  paths = Array(utxoSet.getAllUTXOs().length).fill('0/0'),
  const tx = unsignedTx.getTransaction();
  const typeId = tx.getTxType();

  let canLedgerParse = true;

  let paths = ["0/0"];
  if (typeId === EVMConstants.EXPORTTX) {
    const ins = (tx as EVMExportTx).getInputs();
    paths = ins.map((input) => "0/0");
  } else if (typeId === EVMConstants.IMPORTTX) {
    const ins = (tx as EVMImportTx).getImportInputs();
    paths = ins.map((input) => "0/0");
  }

  // TODO: Remove after ledger update
  // Ledger is not able to parse P/C atomic transactions
  if (typeId === EVMConstants.EXPORTTX) {
    const destChainBuff = (tx as EVMExportTx).getDestinationChain();
    // If destination chain is C chain, sign hash
    // const destChain = idToChainAlias(binTools.cb58Encode(destChainBuff));
    const destChain = "P";
    if (destChain === "P") {
      canLedgerParse = false;
    }
  }
  // TODO: Remove after ledger update
  if (typeId === EVMConstants.IMPORTTX) {
    const sourceChainBuff = (tx as EVMImportTx).getSourceChain();
    // If destination chain is C chain, sign hash
    const sourceChain = "C";
    if (sourceChain === "C") {
      canLedgerParse = false;
    }
  }

  let txSigned;
  console.warn("GETTING SIGNED TX");
  if (canLedgerParse) {
    txSigned = (await signTransactionParsable(
      unsignedTx,
      paths,
      "C",
      avalanche
    )) as EvmTx;
  } else {
    txSigned = (await signTransactionHash(
      unsignedTx,
      paths,
      "C",
      avalanche
    )) as EvmTx;
  }

  return txSigned;
};

const signP = async (
  unsignedTx: PlatformUnsignedTx,
  avalanche
): Promise<PlatformTx> => {
  const tx = unsignedTx.getTransaction();
  const txType = tx.getTxType();
  const chainId = "P";
  const hdHelper = HDHelper.getInstance();
  const extendedPAddresses = hdHelper.getExtendedAddresses();

  const { paths } = getTransactionPathsAndAddresses(
    unsignedTx,
    chainId,
    extendedPAddresses
  );
  // If ledger doesnt support parsing, sign hash
  // let canLedgerParse = getCanLedgerParse(config, unsignedTx);
  //TODO: can remove code below since canLedgerParse will always be false here
  let canLedgerParse = false;
  const isParsableType = true;

  // TODO: Remove after ledger is fixed
  // If UTXOS contain lockedStakeable funds always use sign hash
  // const txIns = unsignedTx.getTransaction().getIns();
  // for (let i = 0; i < txIns.length; i++) {
  //   const typeID = txIns[i].getInput().getTypeID();
  //   if (typeID === STAKEABLELOCKINID) {
  //     canLedgerParse = false;
  //     break;
  //   }
  // }

  // TODO: Remove after ledger update
  // Ledger is not able to parse P/C atomic transactions
  // if (txType === PlatformVMConstants.EXPORTTX) {
  //   const destChainBuff = (tx as PlatformExportTx).getDestinationChain();
  //   // If destination chain is C chain, sign hash
  //   const destChain = "C";
  //   if (destChain === "C") {
  //     canLedgerParse = false;
  //   }
  // }

  // TODO: Remove after ledger update
  if (txType === PlatformVMConstants.IMPORTTX) {
    const sourceChainBuff = (tx as PlatformImportTx).getSourceChain();
    // If destination chain is C chain, sign hash
    const sourceChain = "C";
    if (sourceChain === "C") {
      canLedgerParse = false;
    }
  }

  let signedTx;
  if (canLedgerParse && isParsableType) {
    signedTx = await signTransactionParsable<PlatformUnsignedTx, PlatformTx>(
      unsignedTx,
      paths,
      chainId,
      avalanche
    );
  } else {
    signedTx = await signTransactionHash<PlatformUnsignedTx, PlatformTx>(
      unsignedTx,
      paths,
      chainId,
      avalanche
    );
  }
  return signedTx;
};

const issueP = async (tx: PlatformTx) => {
  return avalancheClient()
    .PChain()
    .issueTx("0x" + binTools.addChecksum(tx.toBuffer()).toString("hex"));
};

const issueC = async (tx: EVMTx) => {
  return avalancheClient()
    .CChain()
    .issueTx("0x" + binTools.addChecksum(tx.toBuffer()).toString("hex"));
};

// STEP 2
const waitExportStatus = async (
  txId: string,
  sourceChain: string,
  avalanche,
  remainingTries = 15
) => {
  let status;
  let exportReason;
  let exportStatus;
  let exportState;
  let importState;
  let importStatus;

  if (sourceChain === "P") {
    let resp = await avalancheClient().PChain().getTxStatus(txId);
    console.log("RESP", resp);

    if (typeof resp === "string") {
      status = resp;
    } else {
      status = resp.status;
      exportReason = resp.reason;
    }
  } else {
    let resp = await avalancheClient().CChain().getAtomicTxStatus(txId);
    console.log("RESP", resp);
    status = resp;
  }
  exportStatus = status;

  if (status === "Unknown" || status === "Processing") {
    console.log("REMAINING TRIES", remainingTries);
    // If out of tries
    if (remainingTries <= 0) {
      exportState = "Failed";
      exportStatus = "Timeout";
      return false;
    }

    // if not confirmed ask again
    const waitExportStatusAgain = async () => {
      await setTimeout(1000);
      await waitExportStatus(txId, sourceChain, avalanche, remainingTries - 1);
    };

    await waitExportStatusAgain();
    return false;
  } else if (status === "Dropped") {
    // If dropped stop the process
    exportState = "failed";

    return false;
  } else {
    // If success start import
    exportState = "success";

    // Because the API nodes are behind a load balancer we are waiting for all api nodes to update
    importState = "started";
    importStatus = "Waiting";
    const targetChain = sourceChain === "P" ? "C" : "P";

    const waitChainImport = async () => {
      await setTimeout(IMPORT_DELAY);
      await chainImport(targetChain, avalanche);
    };

    await waitChainImport();
  }

  return true;
};

// STEP 3
const chainImport = async (targetChain: string, avalanche, canRetry = true) => {
  console.log("INSIDE CHAIN IMPORT");
  let importTxId;
  try {
    if (targetChain === "P") {
      importTxId = await importToPlatformChain("C", avalanche);
    } else {
      console.log("CALCULATING IMPORT FEE");

      //TODO: make function for this fee calculation
      const importFee = GasHelper.estimateImportGasFeeFromMockTx(1, 1);
      const baseFee = await GasHelper.getBaseFeeRecommended();
      const totalFee = bnToBigAvaxC(baseFee.mul(new BN(importFee)));
      const totalFeeBN = bigToBN(totalFee, 9);

      importTxId = await importToCChain("P", totalFeeBN, avalanche);
    }
  } catch (e) {
    const waitChainImportAgain = async () => {
      await setTimeout(IMPORT_DELAY);
      console.log("INSIDE waitChainImportAgain");
      await chainImport(targetChain, avalanche, false);
    };

    // Retry import one more time
    if (canRetry) {
      console.log("CAN RETRY: ", canRetry);
      await waitChainImportAgain();
      return;
    }
    return;
  }

  waitImportStatus(importTxId, targetChain, avalanche);
};

//STEP 4
const waitImportStatus = async (txId: string, targetChain, avalanche) => {
  let status;

  if (targetChain === "P") {
    let resp = await avalancheClient().PChain().getTxStatus(txId);
    if (typeof resp === "string") {
      status = resp;
    } else {
      status = resp.status;
    }
  } else {
    let resp = await avalancheClient().CChain().getAtomicTxStatus(txId);
    status = resp;
  }

  // this.importStatus = status

  if (status === "Unknown" || status === "Processing") {
    const waitImportStatusAgain = async () => {
      await setTimeout(1000);
      await waitImportStatus(txId, targetChain, avalanche);
    };
    // if not confirmed ask again
    await waitImportStatusAgain();
    return false;
  } else if (status === "Dropped") {
    // If dropped stop the process
    // this.importState = TxState.failed
    return false;
  } else {
    return true;
    // If success display success page
    // this.importState = TxState.success
    // this.onsuccess()
  }

  return true;
};

//source chain will always be "C"
const importToPlatformChain = async (
  sourceChain: ExportChainsP,
  avalanche
): Promise<string> => {
  const utxoSet = await platformGetAtomicUTXOs(sourceChain);

  if (utxoSet.getAllUTXOs().length === 0) {
    throw new Error("Nothing to import.");
  }

  const sourceChainId = chainIdFromAlias(sourceChain);
  // Owner addresses, the addresses we exported to
  const hdHelper = HDHelper.getInstance();
  const pToAddr = hdHelper.getCurrentAddress();
  // const pToAddr = "P-fuji16klepv5njslwrvnrja30chu30az73qn6qq09wh";

  const hrp = AVAX_HRP;
  const utxoAddrs = utxoSet
    .getAddresses()
    .map((addr) => binTools.addressToString(hrp, "P", addr));

  const ownerAddrs = utxoAddrs;

  const unsignedTx = await avalancheClient()
    .PChain()
    .buildImportTx(
      utxoSet,
      ownerAddrs,
      sourceChainId,
      [pToAddr],
      [pToAddr],
      [pToAddr],
      undefined,
      undefined
    );
  const tx = await signP(unsignedTx, avalanche);
  return issueP(tx);
};

//source will always be "C"
const platformGetAtomicUTXOs = async (sourceChain) => {
  const hdHelper = HDHelper.getInstance();
  const addrs = hdHelper.getAllDerivedAddresses();

  return await UtxoHelper.platformGetAtomicUTXOs(addrs, sourceChain);
};

const importToCChain = async (sourceChain: ExportChainsC, fee, avalanche) => {
  console.log("INSIDE IMPORT TO C CHAIN");
  let utxoSet = await evmGetAtomicUTXOs(sourceChain);

  if (utxoSet.getAllUTXOs().length === 0) {
    console.log("NOTHING TO IMPORT");
    throw new Error("Nothing to import.");
  }
  let tx;
  console.log("CREATING IMPORT TX");
  try {
    const unsignedTxFee = await createImportTxC(sourceChain, utxoSet, fee);
    tx = await signC(unsignedTxFee, avalanche);
  } catch (e) {
    console.log("ERROR CREATING IMPORT TX", e);
    throw e;
  }

  console.log("ISSUE TX", tx);
  return issueC(tx);
};

const evmGetAtomicUTXOs = async (sourceChain: ExportChainsC) => {
  const addrs = [evmAddress];
  let { utxos } = await avalancheClient().CChain().getUTXOs(addrs, sourceChain);
  return utxos;

  // let res;
  // try {
  //   res = await UtxoHelper.evmGetAtomicUTXOs(addrs, sourceChain);
  // } catch (e) {
  //   console.log("ERROR", e);
  // }

  // return res;
};

const createImportTxC = async (
  sourceChain: ExportChainsC,
  utxoSet: EVMUTXOSet,
  fee
) => {
  const bechAddr = evmAddress;
  const hexAddr = hexAddress;

  const toAddress = "0x" + hexAddr;
  const ownerAddresses = [bechAddr];
  const fromAddresses = ownerAddresses;
  const sourceChainId = avalancheClient().PChain().getBlockchainID();

  return await avalancheClient()
    .CChain()
    .buildImportTx(
      utxoSet,
      toAddress,
      ownerAddresses,
      sourceChainId,
      fromAddresses,
      fee
    );
};

const signTransactionParsable = async <
  UnsignedTx extends PlatformUnsignedTx | EVMUnsignedTx,
  SignedTx extends PlatformTx | EvmTx
>(
  unsignedTx: UnsignedTx,
  paths: string[],
  chainId: string,
  avalanche
): Promise<SignedTx> => {
  // const accountPath = BIPPath.fromString(AVAX_BIP32_PREFIX);
  const bip32Paths = pathsToUniqueBipPaths(paths);
  const accountPath =
    chainId === "C"
      ? BIPPath.fromString(`${ETH_BIP32_PREFIX}`)
      : BIPPath.fromString(`${AVAX_BIP32_PREFIX}`);
  const txbuff = unsignedTx.toBuffer();
  const changePath =
    chainId === "C" ? null : BIPPath.fromString(`${AVAX_BIP32_PREFIX}/0/0`);

  console.warn("ACCOUNT PATH", accountPath);
  console.warn("BIP 32 PATHS", bip32Paths);
  console.warn("CHANGE PATH", changePath);

  const ledgerSignedTx = await avalanche.signTransaction(
    accountPath,
    bip32Paths,
    txbuff,
    changePath
  );

  const sigMap = ledgerSignedTx.signatures;
  const credentials = getCredentials<UnsignedTx>(
    unsignedTx,
    paths,
    sigMap,
    chainId
  );

  let signedTx;

  switch (chainId) {
    case "P":
      signedTx = new PlatformTx(unsignedTx as PlatformUnsignedTx, credentials);
      break;
    case "C":
      signedTx = new EvmTx(unsignedTx as EVMUnsignedTx, credentials);
      break;
  }

  return signedTx as SignedTx;
};

const signTransactionHash = async <
  UnsignedTx extends PlatformUnsignedTx | EVMUnsignedTx,
  SignedTx extends PlatformTx | EvmTx
>(
  unsignedTx: UnsignedTx,
  paths: string[],
  chainId: string,
  avalanche
): Promise<SignedTx> => {
  const txbuff = unsignedTx.toBuffer();
  const msg: Buffer = Buffer.from(createHash("sha256").update(txbuff).digest());

  try {
    const bip32Paths = pathsToUniqueBipPaths(paths);

    // Sign the msg with ledger
    const accountPathSource =
      chainId === "C" ? ETH_BIP32_PREFIX : AVAX_BIP32_PREFIX;
    const accountPath = BIPPath.fromString(`${accountPathSource}`);

    const sigMap = await avalanche.signHash(accountPath, bip32Paths, msg);

    const creds: Credential[] = getCredentials<UnsignedTx>(
      unsignedTx,
      paths,
      sigMap,
      chainId
    );

    let signedTx;
    switch (chainId) {
      case "P":
        signedTx = new PlatformTx(unsignedTx as PlatformUnsignedTx, creds);
        break;
      case "C":
        signedTx = new EvmTx(unsignedTx as EVMUnsignedTx, creds);
        break;
    }
    return signedTx as SignedTx;
  } catch (e) {
    throw e;
  }
};

//For C < - > P cross chain transfers, this will ALWAYS return false.
const getCanLedgerParse = (config, unsignedTx) => {
  let canLedgerParse = config.version >= "0.3.1";

  const txIns = unsignedTx.getTransaction().getIns();

  for (let i = 0; i < txIns.length; i++) {
    let typeID = txIns[i].getInput().getTypeID();
    if (typeID === STAKEABLELOCKINID) {
      canLedgerParse = false;
      break;
    }
  }

  return canLedgerParse;
};

const pathsToUniqueBipPaths = (paths: string[]) => {
  const uniquePaths = paths.filter((val: any, i: number) => {
    return paths.indexOf(val) === i;
  });

  const bip32Paths = uniquePaths.map((path) => {
    return BIPPath.fromString(path, false);
  });

  return bip32Paths;
};

const getTransactionPathsAndAddresses = (unsignedTx, chainId, pAddresses) => {
  unsignedTx.toBuffer();
  const tx = unsignedTx.getTransaction();
  const txType = tx.getTxType();

  const ins = tx.getIns ? tx.getIns() : [];
  let operations: TransferableOperation[] = [];

  // Try to get operations, it will fail if there are none, ignore and continue
  try {
    operations = (tx as OperationTx).getOperations();
  } catch (e) {
    console.log(e);
  }

  let items = ins;
  if (
    (txType === AVMConstants.IMPORTTX && chainId === "X") ||
    (txType === PlatformVMConstants.IMPORTTX && chainId === "P")
  ) {
    items = ((tx as AVMImportTx) || PlatformImportTx).getImportInputs();
  }

  const hrp = AVAX_HRP;
  const paths: string[] = [];
  const addresses: string[] = [];

  // Collect derivation paths for source addresses
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sigidxs: SigIdx[] = item.getInput().getSigIdxs();
    const sources = sigidxs.map((sigidx) => sigidx.getSource());
    const addrs: string[] = sources.map((source) => {
      return binTools.addressToString(hrp, chainId, source);
    });

    for (let j = 0; j < addrs.length; j++) {
      const srcAddr = addrs[j];
      const pathStr = getPathFromAddress(srcAddr, pAddresses);

      paths.push(pathStr);
      addresses.push(srcAddr);
    }
  }

  // Do the Same for operational inputs, if there are any...
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const sigidxs: SigIdx[] = op.getOperation().getSigIdxs();
    const sources = sigidxs.map((sigidx) => sigidx.getSource());
    const addrs: string[] = sources.map((source) => {
      return binTools.addressToString(hrp, chainId, source);
    });

    for (let j = 0; j < addrs.length; j++) {
      const srcAddr = addrs[j];
      const pathStr = getPathFromAddress(srcAddr, pAddresses);

      paths.push(pathStr);
      addresses.push(srcAddr);
    }
  }

  return { paths, addresses };
};

const getCredentials = <
  UnsignedTx extends AVMUnsignedTx | PlatformUnsignedTx | EVMUnsignedTx
>(
  unsignedTx: UnsignedTx,
  paths: string[],
  sigMap: any,
  chainId: string
): Credential[] => {
  const creds: Credential[] = [];
  const tx = unsignedTx.getTransaction();
  const txType = tx.getTxType();

  // @ts-ignore
  const ins = tx.getIns ? tx.getIns() : [];
  let operations: TransferableOperation[] = [];
  let evmInputs: EVMInput[] = [];

  let items = ins;
  if (
    (txType === AVMConstants.IMPORTTX && chainId === "X") ||
    (txType === PlatformVMConstants.IMPORTTX && chainId === "P") ||
    (txType === EVMConstants.IMPORTTX && chainId === "C")
  ) {
    items = (
      (tx as AVMImportTx) ||
      PlatformImportTx ||
      EVMImportTx
    ).getImportInputs();
  }

  // console.error("ITEMS", items);

  // Try to get operations, it will fail if there are none, ignore and continue
  try {
    operations = (tx as OperationTx).getOperations();
  } catch (e) {
    console.log(e);
  }

  // Try to get evm inputs, it will fail if there are none, ignore and continue
  try {
    evmInputs = (tx as EVMExportTx).getInputs();
  } catch (e) {
    console.error(e);
  }

  const CredentialClass = PlatformSelectCredentialClass;

  for (let i = 0; i < items.length; i++) {
    const sigidxs: SigIdx[] = items[i].getInput().getSigIdxs();
    const cred: Credential = CredentialClass(
      items[i].getInput().getCredentialID()
    );

    for (let j = 0; j < sigidxs.length; j++) {
      const pathIndex = i + j;
      const pathStr = paths[pathIndex];

      const sigRaw = sigMap.get(pathStr);
      const sigBuff = AvalancheBuffer.from(sigRaw);
      const sig: Signature = new Signature();
      sig.fromBuffer(sigBuff);
      cred.addSignature(sig);
    }
    creds.push(cred);
  }

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i].getOperation();
    const sigidxs: SigIdx[] = op.getSigIdxs();
    const cred: Credential = CredentialClass(op.getCredentialID());

    for (let j = 0; j < sigidxs.length; j++) {
      const pathIndex = items.length + i + j;
      const pathStr = paths[pathIndex];

      const sigRaw = sigMap.get(pathStr);
      const sigBuff = AvalancheBuffer.from(sigRaw);
      const sig: Signature = new Signature();
      sig.fromBuffer(sigBuff);
      cred.addSignature(sig);
    }
    creds.push(cred);
  }

  for (let i = 0; i < evmInputs.length; i++) {
    const evmInput = evmInputs[i];
    const sigidxs: SigIdx[] = evmInput.getSigIdxs();
    const cred: Credential = CredentialClass(evmInput.getCredentialID());

    for (let j = 0; j < sigidxs.length; j++) {
      const pathIndex = items.length + i + j;
      const pathStr = paths[pathIndex];

      const sigRaw = sigMap.get(pathStr);
      const sigBuff = AvalancheBuffer.from(sigRaw);
      const sig: Signature = new Signature();
      sig.fromBuffer(sigBuff);
      cred.addSignature(sig);
    }
    creds.push(cred);
  }

  return creds;
};;;

const getPathFromAddress = (address: string, pAddresses: string[]) => {
  const platformIndex = pAddresses.indexOf(address);

  if (platformIndex >= 0) {
    return `0/${platformIndex}`;
  }

  throw "Unable to find source address.";
};

const buildOptimisticOperation = (
  account: Account,
  transaction: Transaction
): Operation => {
  let type: OperationType;

  switch (transaction.mode) {
    case "delegate":
      type = "DELEGATE";
      break;
    default:
      type = "OUT";
  }

  const fee = transaction.fees ?? new BigNumber(0);
  const value = new BigNumber(transaction.amount).plus(fee);

  const operation: Operation = {
    id: encodeOperationId(account.id, "", type),
    hash: "",
    type,
    value: new BigNumber(0),
    fee,
    blockHash: null,
    blockHeight: null,
    senders: [],
    recipients: [],
    accountId: account.id,
    date: new Date(),
    extra: {
      validator: transaction.recipient,
      stakeValue: value,
    },
  };

  return operation;
};

export default signOperation;
