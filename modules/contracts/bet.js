var TransactionTypes = require("../helpers/transaction-types.js");
var constants = require("../helpers/constants.js");

var private = {}, self = null,
	library = null, modules = null;

var MAX_ODDS = 3; // 最高赔率
var uBetsNumber = {};

function Bet(cb, _library) {
	self = this;
	library = _library;
	cb(null, self);
}

Bet.prototype.create = function (data, trs) {
	trs.recipientId = null;
	trs.amount = data.amount;
	trs.asset.bet = {
		rule: data.rule,
		point: data.point,
		rollId: data.rollId
	}
	return trs;
}

Bet.prototype.calculateFee = function (trs) {
	return 0.1 * constants.fixedPoint;
}

Bet.prototype.verify = function (trs, sender, cb, scope) {
	if (trs.recipientId) {
		return cb("Invalid recipientId, should not exist");
	}

	var rule = trs.asset.bet.rule;
	if (typeof rule != "number" || rule < 1 || rule > 3) {
		return cb("Invalid bet rule, must be number 1-3");
	}
	var rollId = trs.asset.bet.rollId;
	modules.contracts.roll.getRoll(rollId, function (err, rollTrs) {
		if (err || !rollTrs) {
			return cb(err || "Roll not found");
		}
		if (self.getPlayerNumber(rollId) == rollTrs.maxPlayer) {
			return cb("Player number exceed the limit");
		}
		if (trs.amount * MAX_ODDS * rollTrs.maxPlayer > rollTrs.amount) {
			return cb("Amount exceed the limit");
		}
		return cb(null, trs);
	}, {id: rollId});
}

Bet.prototype.getBytes = function (trs) {
	var content = "";
	content += trs.asset.bet.rule;
	content += trs.asset.bet.point;
	content += trs.asset.bet.rollId;
	try {
		var buf = new Buffer(content, "utf8");
	} catch (e) {
		throw Error(e.toString());
	}
	return buf;
}

Bet.prototype.apply = function (trs, sender, cb, scope) {
	modules.blockchain.accounts.mergeAccountAndGet({
		address: sender.address,
		balance: {"XAS": -(trs.amount + trs.fee)}
	}, cb, scope);
}

Bet.prototype.undo = function (trs, sender, cb, scope) {
	modules.blockchain.accounts.undoMerging({
		address: sender.address,
		balance: {"XAS": -(trs.amount + trs.fee)}
	}, cb, scope);
}

Bet.prototype.applyUnconfirmed = function (trs, sender, cb, scope) {
	var sum = trs.amount + trs.fee;

	if (modules.contracts.reveal.hasConfirmed(trs.asset.bet.rollId)) {
		return cb("The game already finished");
	}

	if (sender.u_balance["XAS"] < sum) {
		return cb("Account does not have enough XAS");
	}

	modules.blockchain.accounts.mergeAccountAndGet({
		address: sender.address,
		u_balance: {"XAS": -sum}
	}, function (err, account) {
		if (!err) {
			var rollId = trs.asset.bet.rollId;
			if (!uBetsNumber[rollId]) {
				uBetsNumber[rollId] = 0;
			}
			uBetsNumber[rollId]++;
		}
		cb(err, account);
	}, scope);
}

Bet.prototype.undoUnconfirmed = function (trs, sender, cb, scope) {
	delete uBetsNumber[trs.id];
	modules.blockchain.accounts.undoMerging({
		address: sender.address,
		u_balance: {"XAS": -(trs.amount + trs.fee)}
	}, cb, scope);
}

Bet.prototype.ready = function (trs, sender, cb, scope) {
	setImmediate(cb);
}

Bet.prototype.save = function (trs, cb) {
	modules.api.sql.insert({
		table: "asset_bet",
		values: {
			rule: trs.asset.bet.rule,
			point: trs.asset.bet.point,
			rollId: trs.asset.bet.rollId,
			transactionId: trs.id
		}
	}, cb);
}

Bet.prototype.dbRead = function (row) {
	if (!row.t_be_transactionId) {
		return null;
	}
	return {
		bet: {
			rule: row.t_be_rule,
			point: row.t_be_point,
			rollId: row.t_be_rollId
		}
	};
}

Bet.prototype.normalize = function (asset, cb) {
	setImmediate(cb);
}

Bet.prototype.onBind = function (_modules) {
	modules = _modules;
	modules.logic.transaction.attachAssetType(TransactionTypes.BET, self);
}

Bet.prototype.getPlayerNumber = function (rollId) {
	return uBetsNumber[rollId] || 0;
}

Bet.prototype.add = function (cb, query) {
	if (!query.secret || !query.rule || !query.amount || !query.rollId) {
		return cb("Invalid params");
	}
	query.amount = Number(query.amount);
	query.rule = Number(query.rule);
	query.point = query.point ? Number(query.point) : 0;

	var keypair = modules.api.crypto.keypair(query.secret);
	var publicKey = keypair.publicKey.toString("hex");
	library.sequence.add(function (cb) {
		modules.blockchain.accounts.getAccount({publicKey: publicKey}, function (err, account) {
			if (err) {
				return cb(err.toString());
			}
			if (!account || !account.publicKey) {
				return cb("Account not found");
			}

			try {
				var transaction = modules.logic.transaction.create({
					type: TransactionTypes.BET,
					sender: account,
					keypair: keypair,
					amount: query.amount,
					rule: query.rule,
					point: query.point,
					rollId: query.rollId
				});
			} catch (e) {
				return cb(e.toString());
			}

			modules.blockchain.transactions.processUnconfirmedTransaction(transaction, cb)
		});
	}, function (err, transaction) {
		if (err) {
			return cb(err.toString());
		}

		cb(null, {transaction: transaction});
	});
}

Bet.prototype.getBetsForRoll = function (id, cb) {
	modules.api.sql.select({
			table: "asset_bet",
			alias: "tbe",
			condition: {
				rollId: id,
			},
			join: [{
				type: "left outer",
				table: "transactions",
				alias: "t",
				on: {
					"t.id": "tbe.transactionId"
				}
			}],
			fields: [
				{ "t.id": "id" },
				{ "t.senderId": "senderId" },
				{ "t.amount": "amount" },
				{ "tbe.rule": "rule" },
				{ "tbe.point": "point" },
				{ "tbe.rollId": "rollId" }
			]
		},
		{
			"id": String,
			"senderId": String,
			"amount": Number,
			"rule": Number,
			"point": Number,
			"rollId": String
		}, function (err, bets) {
			if (err) {
				return cb(err.toString());
			}
			return cb(null, bets);
		});
}

module.exports = Bet;
