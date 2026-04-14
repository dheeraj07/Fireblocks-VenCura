import solc from "solc";

interface SolcOutputError {
  severity: string;
  formattedMessage: string;
}

interface CompiledContractArtifact {
  abi: unknown[];
  bytecode: string;
}

let cachedArtifact: CompiledContractArtifact | undefined;

export function getTestErc20Artifact(): CompiledContractArtifact {
  if (cachedArtifact) {
    return cachedArtifact;
  }

  const source = `
    // SPDX-License-Identifier: MIT
    pragma solidity ^0.8.20;

    contract TestToken {
      string public constant name = "Test Token";
      string public constant symbol = "TEST";
      uint8 public constant decimals = 18;
      uint256 public totalSupply;

      mapping(address => uint256) public balanceOf;

      event Transfer(address indexed from, address indexed to, uint256 value);

      constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
      }

      function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");

        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;

        emit Transfer(msg.sender, to, value);
        return true;
      }
    }
  `;

  const input = {
    language: "Solidity",
    sources: {
      "TestToken.sol": {
        content: source
      }
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode"]
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    contracts?: {
      "TestToken.sol"?: {
        TestToken?: {
          abi: unknown[];
          evm: {
            bytecode: {
              object: string;
            };
          };
        };
      };
    };
    errors?: SolcOutputError[];
  };

  const compilationErrors = (output.errors ?? []).filter((error) => error.severity === "error");

  if (compilationErrors.length > 0) {
    throw new Error(
      `Failed to compile TestToken.sol:\n${compilationErrors
        .map((error) => error.formattedMessage)
        .join("\n")}`
    );
  }

  const contract = output.contracts?.["TestToken.sol"]?.TestToken;

  if (!contract) {
    throw new Error("Compiled ERC-20 artifact was not found.");
  }

  cachedArtifact = {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`
  };

  return cachedArtifact;
}
