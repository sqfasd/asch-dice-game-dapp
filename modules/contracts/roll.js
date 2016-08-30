var crypto = require("crypto");
var async = require("async");
var TransactionTypes = require("../helpers/transaction-types.js");
var constants = require("../helpers/constants.js");

var private = {}, self = null,
	library = null, modules = null;

function Roll(cb, _library) {
	self = this;
	library = _library;
	cb(null, self);
}

Roll.prototype.create = function (data, trs) {
	trs.recipientId = null;
	trs.amount = data.amount;
	trs.asset.roll = {
		maxPlayer: data.maxPlayer,
		pointsHash: data.pointsHash
	}
	return trs;
}

Roll.prototype.calculateFee = function (trs) {
	return 0.1 * constants.fixedPoint;
}

Roll.prototype.verify = function (trs, sender, cb, scope) {
	if (trs.recipientId) {
		return cb("Invalid recipientId, should not exist");
	}
	if (trs.amount <= 1 * constants.fixedPoint) {
		return cb("Invalid amount, should not less than 1 XAS");
	}
	if (trs.asset.roll.maxPlayer <= 0) {
		return cb("Invalid maxPlayer, should not less than 1");
	}
	if (!trs.asset.roll.pointsHash) {
		return cb("Invalid pointsHash");
	}
	setImmediate(cb, null, trs);
}

Roll.prototype.getBytes = function (trs) {
	var content = "";
	content += trs.asset.roll.maxPlayer;
	content += trs.asset.roll.pointsHash;
	try {
		var buf = new Buffer(content, "utf8");
	} catch (e) {
		throw Error(e.toString());
	}
	return buf;
}

Roll.prototype.apply = function (trs, sender, cb, scope) {
	modules.blockchain.accounts.mergeAccountAndGet({
		address: sender.address,
		balance: {"XAS": -(trs.amount + trs.fee)}
	}, cb, scope);
}

Roll.prototype.undo = function (trs, sender, cb, scope) {
	modules.blockchain.accounts.undoMerging({
		address: sender.address,
		balance: {"XAS": -(trs.amount + trs.fee)}
	}, cb, scope);
}

Roll.prototype.applyUnconfirmed = function (trs, sender, cb, scope) {
	var sum = trs.amount + trs.fee;

	if (sender.u_balance["XAS"] < sum) {
		return cb("Account does not have enough XAS");
	}

	modules.blockchain.accounts.mergeAccountAndGet({
		address: sender.address,
		u_balance: {"XAS": -sum}
	}, cb, scope);
}

Roll.prototype.undoUnconfirmed = function (trs, sender, cb, scope) {
	modules.blockchain.accounts.undoMerging({
		address: sender.address,
		u_balance: {"XAS": -(trs.amount + trs.fee)}
	}, cb, scope);
}

Roll.prototype.ready = function (trs, sender, cb, scope) {
	setImmediate(cb);
}

Roll.prototype.save = function (trs, cb) {
	modules.api.sql.insert({
		table: "asset_roll",
		values: {
			maxPlayer: trs.asset.roll.maxPlayer,
			pointsHash: trs.asset.roll.pointsHash,
			transactionId: trs.id
		}
	}, cb);
}

Roll.prototype.dbRead = function (row) {
	if (!row.t_ro_transactionId) {
		return null;
	}
	return {
		roll: {
			maxPlayer: row.t_ro_maxPlayer,
			pointsHash: row.t_ro_pointsHash
		}
	};
}

Roll.prototype.normalize = function (asset, cb) {
	setImmediate(cb);
}

Roll.prototype.onBind = function (_modules) {
	modules = _modules;
	modules.logic.transaction.attachAssetType(TransactionTypes.ROLL, self);
}

Roll.prototype.genRandomRoll = function () {
	var points = [];
	for (var i = 0; i < 3; ++i) {
		points.push(Math.floor(Math.random() * 6 + 1));
	}
	return {
		points: points,
		nonce: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
	}
}

Roll.prototype.getPointsHash = function (points, nonce) {
	var sha256 = crypto.createHash("sha256");
	var data = points.concat([nonce]);
	return sha256.update(data.join()).digest().toString("hex");
}

Roll.prototype.add = function (cb, query) {
	if (!query.secret || !query.amount || !query.maxPlayer) {
		return cb("Invalid params");
	}
	var pointsHash;
	var rollData;
	if (query.pointsHash) {
		pointsHash = query.pointsHash;
	} else {
		rollData = self.genRandomRoll();
		pointsHash = self.getPointsHash(rollData.points, rollData.nonce);
	}
	query.amount = Number(query.amount);
	query.maxPlayer = Number(query.maxPlayer);
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
					type: TransactionTypes.ROLL,
					sender: account,
					keypair: keypair,
					amount: query.amount,
					pointsHash: pointsHash,
					maxPlayer: query.maxPlayer
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
		var resp = {transaction: transaction};
		if (!query.pointsHash) {
			resp.points = rollData.points.join(),
			resp.nonce = rollData.nonce;
		}
		cb(null, resp);
	});
}

Roll.prototype.getRollAndBets = function (id, cb) {
	self.getRoll(id, function (err, roll) {
		if (err || !roll) {
			return cb(err || "Roll not found");
		}
		modules.contracts.bet.getBetsForRoll(id, function (err, bets) {
			if (err) {
				return cb(err);
			}
			return cb(null, {roll: roll, bets: bets});
		});
	});
}

Roll.prototype.getRoll = function (id, cb) {
	self.list(function (err, resp) {
		if (err || !resp || !resp.rolls) {
			return cb(err || "Roll not found");
		}
		cb(null, resp.rolls[0]);
	}, {id: id});
}

Roll.prototype.get = function (cb, query) {
	if (!query.id) {
		return cb("Invalid params");
	}
	if (query.detail == "true") {
		self.getRollAndBets(query.id, cb);
	} else {
		self.getRoll(query.id, function (err, roll) {
			cb(err, {roll: roll});
		});
	}
}

Roll.prototype.list = function (cb, query) {
	var condition = {type: TransactionTypes.ROLL};
	if (query.id) {
		condition.id = query.id;
	}
	modules.api.sql.select({
		table: "transactions",
		alias: "t",
		condition: condition,
		limit: query.limit ? Number(query.limit) : 20,
		offset: query.offset ? Number(query.offset) : 0,
		sort: {
			timestamp: -1
		},
		join: [{
			type: "left outer",
			table: "asset_roll",
			alias: "tro",
			on: {
				"t.id": "tro.transactionId"
			}
		}],
		fields: [
			{ "t.id": "id" },
			{ "t.senderId": "senderId" },
			{ "t.amount": "amount" },
			{ "tro.pointsHash": "pointsHash" },
			{ "tro.maxPlayer": "maxPlayer" }
		]},
		{
			"id": String,
			"senderId": String,
			"amount": Number,
			"pointsHash": String,
			"maxPlayer": Number
		},
		function (err, rolls) {
			if (err) {
				return cb(err.toString());
			}
			if (query.detail != "true") {
				return cb(null, {rolls: rolls});
			}
			async.map(rolls, function (roll, next) {
				var obj = {
					roll: roll
				}
				async.series([
					function (next) {
						modules.contracts.bet.getBetsForRoll(roll.id, function (err, bets) {
							if (!err) {
								obj.bets = bets;
							}
							next(err);
						});
					},
					function (next) {
						modules.contracts.reveal.getRevealForRoll(roll.id, function (err, reveal) {
							if (!err &&　reveal) {
								obj.reveal = reveal;
							}
							next(err);
						});
					}
				], function (err) {
					next(err, obj);
				});
			}, function (err, details) {
				if (err) {
					return cb(err);
				}
				cb(null, {rolls: details});
			});
		});
}

module.exports = Roll;