import Avalanche from "avalanche";
import { getEnv } from "../../../env";
import Web3 from "web3";

let avalanche: Avalanche;
let web3: Web3;

export const avalancheClient = () => {
  if (!avalanche) {
    const node = `${getEnv("API_AVALANCHE_NODE")}`;

    const url = new URL(node);
    avalanche = new Avalanche(url.hostname, Number(url.port));
    avalanche.setNetworkID(5); //5 = "FUJI", 1 = MAINNET "AVAX". DELETE THIS LINE IF ON MAINNET

    //not sure why this is necessary, but it doesn't automatically reset
    avalancheClient().CChain().refreshBlockchainID();
    avalancheClient().PChain().refreshBlockchainID();
  }

  return avalanche;
};

export const web3Client = () => {
  if (!web3) {
    const node = `${getEnv("API_AVALANCHE_NODE")}`;
    web3 = new Web3(`${node}/ext/bc/C/rpc`);
  }

  return web3;
};
