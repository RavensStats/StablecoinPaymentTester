//
// CONFIG
//
const TOKEN_ADDRESS = "0x1c7D4B196Cb0C7AeD2fa9DAB76B76e95D9BA9A02"; // USDC Sepolia
const DECIMALS = 6;

const ABI = [
    {
        "constant": false,
        "inputs": [
            { "name": "recipient", "type": "address" },
            { "name": "amount", "type": "uint256" }
        ],
        "name": "transfer",
        "outputs": [{ "name": "", "type": "bool" }],
        "type": "function"
    }
];

let web3;
let accounts;


//
// CONNECT WALLET
//
document.getElementById("connectBtn").onclick = async () => {
    if (!window.ethereum) return alert("MetaMask required.");

    accounts = await ethereum.request({ method: "eth_requestAccounts" });
    web3 = new Web3(window.ethereum);

    document.getElementById("wallet").innerHTML = "Connected: " + accounts[0];
};


//
// SHA-256 HASH
//
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = [...new Uint8Array(hashBuffer)];
    return hashArray.map(b=>b.toString(16).padStart(2,"0")).join("");
}


//
// MERKLE TREE BUILDER
//
async function merkleRoot(hashes) {
    if (hashes.length === 0) return null;
    if (hashes.length === 1) return hashes[0];

    let level = hashes;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i+1] || left;
            const combined = await sha256(left + right);
            next.push(combined);
        }
        level = next;
    }
    return level[0];
}


//
// LEDGER GENERATION FUNCTION
//
function generateLedger(amount, currencyInput, fx, splitRules) {

    let usdcAmount = currencyInput === "USD" ? amount * fx : amount;
    const totalCents = Math.round(usdcAmount * 100);

    let ledger = [];
    let allocated = 0;

    splitRules.forEach(s => {
        const share = Math.round((s.percent / 100) * totalCents);
        allocated += share;
        ledger.push({
            address: s.address,
            percent: s.percent,
            cents: share,
            usdc: (share / 100).toFixed(2)
        });
    });

    const diff = totalCents - allocated;
    if (diff !== 0) {
        ledger[0].cents += diff;
        ledger[0].usdc = (ledger[0].cents / 100).toFixed(2);
    }

    return { usdcAmount, totalCents, ledger, roundingCorrection: diff };
}


//
// TX VERIFICATION (LIVE MODE)
//
async function verifyTx(txHash, expectedTo, expectedCents) {
    const receipt = await web3.eth.getTransactionReceipt(txHash);
    if (!receipt || !receipt.status) return false;

    // Basic check
    if (!receipt.logs || receipt.logs.length === 0) return false;

    // Test transfer event by checking presence of data/addresses
    const amtWeiExpected = BigInt(expectedCents) * BigInt(10 ** (DECIMALS - 2));
    const amtHex = "0x" + amtWeiExpected.toString(16);

    return receipt.logs.some(log =>
        log.topics.some(t => t.includes(expectedTo.slice(2))) ||
        log.data.includes(amtHex.slice(2))
    );
}


//
// RUN SINGLE TEST
//
document.getElementById("runBtn").onclick = async () => {
    let out = "";
    const log = x => (out += x + "\n");

    const mode = document.getElementById("mode").value;
    const currencyInput = document.getElementById("currencyInput").value;
    const amount = parseFloat(document.getElementById("amount").value);
    const fx = parseFloat(document.getElementById("fx").value);
    const splits = JSON.parse(document.getElementById("splitRules").value);

    const result = generateLedger(amount, currencyInput, fx, splits);

    log("--- Payment Breakdown ---");
    log(`USDC Amount: ${result.usdcAmount}`);
    log(`Total Cents: ${result.totalCents}`);
    log(`Rounding Correction: ${result.roundingCorrection}`);

    result.ledger.forEach(e =>
        log(`${e.address}: ${e.usdc} USDC (${e.cents} cents)`)
    );

    if (mode === "simulate") {
        document.getElementById("output").innerText = out;
        return;
    }

    const contract = new web3.eth.Contract(ABI, TOKEN_ADDRESS);

    for (let e of result.ledger) {
        const amountWei = BigInt(e.cents) * BigInt(10 ** (DECIMALS - 2));
        const tx = await contract.methods
            .transfer(e.address, amountWei)
            .send({ from: accounts[0] });

        const verified = await verifyTx(tx.transactionHash, e.address, e.cents);

        log(`TX: ${tx.transactionHash}`);
        log(`Verified: ${verified ? "YES" : "NO (WARNING)"}`);
        log("");
    }

    document.getElementById("output").innerText = out;
};


//
// AUTOMATED TEST RUNNER + MERKLE TREE
//
document.getElementById("runAutoTestBtn").onclick = async () => {
    const testCount = parseInt(document.getElementById("testCount").value);
    const randomFX = document.getElementById("randomFX").checked;
    const randomSplits = document.getElementById("randomSplits").checked;

    let audits = [];
    let hashes = [];
    let roundingIssues = 0;

    for (let i = 0; i < testCount; i++) {
        const amount = Math.random() * 500 + 1;
        const fx = randomFX ? (0.95 + Math.random() * 0.1) : 1.0;

        let splits;
        if (randomSplits) {
            const n = Math.floor(Math.random() * 3) + 3;
            let percLeft = 100;
            splits = [];
            for (let k = 0; k < n - 1; k++) {
                const p = Math.floor(Math.random() * (percLeft - (n - k - 1))) + 1;
                percLeft -= p;
                splits.push({ address: `0xTEST${i}_${k}`, percent: p });
            }
            splits.push({ address: `0xTEST${i}_${n - 1}`, percent: percLeft });
        } else {
            splits = JSON.parse(document.getElementById("splitRules").value);
        }

        const result = generateLedger(amount, "USD", fx, splits);

        const auditObject = {
            testNumber: i + 1,
            amount,
            fx,
            splits,
            ledger: result.ledger,
            totalCents: result.totalCents,
            roundingCorrection: result.roundingCorrection
        };

        const hash = await sha256(JSON.stringify(auditObject));
        auditObject.hash = hash;

        audits.push(auditObject);
        hashes.push(hash);

        if (result.roundingCorrection !== 0) roundingIssues++;
    }

    const root = await merkleRoot(hashes);

    document.getElementById("auditOutput").innerText =
        JSON.stringify(
            {
                totalTests: testCount,
                roundingIssues,
                merkleRoot: root,
                audits
            },
            null,
            2
        );
};
