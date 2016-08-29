var async = require("async");
var TransactionTypes = require("../helpers/transaction-types.js");
var constants = require("../helpers/constants.js");

var private = {}, self = null,
	library = null, modules = null;

var reveals = {};
var uReveals = {};

function Reveal(cb, _library) {
	self = this;
	library = _library;
	cb(null, self);
}

Reveal.prototype.create = function (data, trs) {
	trs.recipientId = null;
	trs.amount = 0;
	trs.asset.reveal = {
		nonce: data.nonce,
		points: data.points,
		rollId: data.rollId
	}
	return trs;
}

Reveal.prototype.calculateFee = function (trs) {
	return 0.1 * constants.fixedPoint;
}

Reveal.prototype.verify = function (trs, sender, cb, scope) {
	if (trs.recipientId) {
		return cb("Invalid recipientId, should not exist");
	}
	var nonce = trs.asset.reveal.nonce;
	if (typeof nonce != "number") {
		return cb("Invalid nonce, should be number");
	}
	var points = trs.asset.reveal.points;
	if (!(typeof points == "object" && points instanceof Array && points.length == 3)) {
		return cb("Invalid points format, should be array with 3 elements");
	}
	for (var i = 0; i < points.length; ++i) {
		if (typeof points[i] != "number" || points[i] < 1 || points[i] > 6) {
			return cb("Invalid points data");
		}
	}

	var rollId = trs.asset.reveal.rollId;

	modules.contracts.roll.getRoll(rollId, function (err, rollTrs) {
		if (err || !rollTrs) {
			return cb(err || "Roll not found");
		}
		var pointsHash = modules.contracts.roll.getPointsHash(points, nonce);
		if (pointsHash != rollTrs.pointsHash) {
			return cb("Incorrect points hash");
		}
		return cb(null, trs);
	});
}

Reveal.prototype.getBytes = function (trs) {
	var content = "";
	content += trs.asset.reveal.nonce;
	content += trs.asset.reveal.points.join();
	content += trs.asset.reveal.rollId;
	try {
		var buf = new Buffer(content, "utf8");
	} catch (e) {
		throw Error(e.toString());
	}
	return buf;
}

Reveal.prototype.apply = function (trs, sender, cb, scope) {
	modules.contracts.roll.getRollAndBets(trs.asset.reveal.rollId, function (err, result) {
		if (err) {
			return cb(err);
		}
		self.settleBalance(trs.asset.reveal.points, result.roll, result.bets);
		modules.blockchain.accounts.mergeAccountAndGet({
			address: result.roll.senderId,
			balance: {"XAS": result.roll.amount - trs.fee},
			u_balance: {"XAS": result.roll.amount}
		}, function (err) {
			if (err) {
				return cb(err);
			}
			async.eachSeries(result.bets, function (bet, next) {
				if (bet.amount == 0) {
					return next();
				}
				modules.blockchain.accounts.mergeAccountAndGet({
					address: bet.senderId,
					balance: {"XAS": bet.amount},
					u_balance: {"XAS": bet.amount}
				}, next);
			}, function (err) {
				if (!err) {
					reveals[trs.asset.reveal.rollId] = true;
				}
				cb(err);
			});
		});
	});
}

Reveal.prototype.undo = function (trs, sender, cb, scope) {
	delete reveals[trs.asset.reveal.rollId];
	modules.contracts.roll.getRollAndBets(trs.asset.reveal.rollId, function (err, result) {
		if (err) {
			return cb(err);
		}
		self.settleBalance(trs.asset.reveal.points, result.roll, result.bets);
		modules.blockchain.accounts.undoMerging({
			address: result.roll.senderId,
			balance: {"XAS": result.roll.amount - trs.fee},
			u_balance: {"XAS": result.roll.amount}
		}, function (err) {
			if (err) {
				return cb(err);
			}
			async.eachSeries(result.bets, function (bet, next) {
				if (bet.amount == 0) {
					return next();
				}
				modules.blockchain.accounts.undoMerging({
					address: bet.senderId,
					balance: {"XAS": bet.amount},
					u_balance: {"XAS": bet.amount}
				}, next);
			}, cb);
		});
	});
}

Reveal.prototype.applyUnconfirmed = function (trs, sender, cb, scope) {
	if (uReveals[trs.asset.reveal.rollId]) {
		return setImmediate(cb, "The game already finished");
	}
	if (sender.u_balance["XAS"] < trs.fee) {
		return setImmediate(cb, "Account has no XAS");
	}
	modules.blockchain.accounts.mergeAccountAndGet({
		address: sender.address,
		u_balance: {"XAS": -trs.fee}
	}, function (err, account) {
		if (!err) {
				uReveals[trs.asset.reveal.rollId] = true;
		}
		cb(err, account);
	}, scope);
}

Reveal.prototype.undoUnconfirmed = function (trs, sender, cb, scope) {
	delete uReveals[trs.asset.reveal.rollId];
	modules.blockchain.accounts.undoMerging({
		address: sender.address,
		u_balance: {"XAS": -trs.fee}
	}, cb, scope);
}

Reveal.prototype.ready = function (trs, sender, cb, scope) {
	setImmediate(cb);
}

Reveal.prototype.save = function (trs, cb) {
	modules.api.sql.insert({
		table: "asset_reveal",
		values: {
			nonce: trs.asset.reveal.nonce,
			points: trs.asset.reveal.points.join(),
			rollId: trs.asset.reveal.rollId,
			transactionId: trs.id
		}
	}, cb);
}

Reveal.prototype.dbRead = function (row) {
	if (!row.t_re_transactionId) {
		return null;
	}
	return {
		reveal: {
			nonce: row.t_re_nonce,
			points: row.t_re_points.split(","),
			rollId: row.t_re_rollId
		}
	};
}

Reveal.prototype.normalize = function (asset, cb) {
	setImmediate(cb);
}

Reveal.prototype.onBind = function (_modules) {
	modules = _modules;
	modules.logic.transaction.attachAssetType(TransactionTypes.REVEAL, self);
}

Reveal.prototype.hasConfirmed = function (rollId) {
	return reveals[rollId] == true;
}

Reveal.prototype.calculateResult = function (points, rule, betPoint) {
	var totalPoint = points[0] + points[1] + points[2];
	var result = {
		win: false,
		odds: 1
	}
	switch (rule) {
		case 1:
			var big = totalPoint > 10 ? 1 : 0;
			if (big == betPoint) {
				result.win = true;
			}
			break;
		case 2:
			var betCount = 0;
			for (var i = 0; i < points.length; ++i) {
				if (points[i] == betPoint) {
					betCount++;
				}
			}
			if (betCount > 0) {
				result.win = true;
				result.odds = betCount;
			}
			break;
		case 3:
			if (totalPoint == betPoint) {
				result.win = true;
				result.odds = 2;
			} else if (Math.abs(totalPoint - betPoint) == 1) {
				result.win = true;
				result.odds = 1;
			}
			break;
		default:
			break;
	}
	return result;
}

Reveal.prototype.settleBalance = function (points, roll, bets) {
	// TODO strictly validate
	if (!roll || !roll.senderId || !roll.pointsHash) {
		return null;
	}
	for (var i = 0; i < bets.length; ++i) {
		var bet = bets[i];
		var result = self.calculateResult(points, bet.rule, bet.point);
		if (result.win) {
			var winAmount = bet.amount * result.odds;
			roll.amount -= winAmount;
			bet.amount += winAmount;
		} else {
			roll.amount += bet.amount;
			bet.amount = 0;
		}
	}
}

Reveal.prototype.add = function (cb, query) {
	if (!query.secret || !query.points || !query.rollId) {
		return cb("Invalid params");
	}
	query.nonce = query.nonce ? Number(query.nonce) : 0;
	query.points = query.points.split(",");
	if (query.points.length != 3) {
		return cb("Invalid points");
	}
	query.points = query.points.map(function (i) {
		return Number(i);
	});

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
					type: TransactionTypes.REVEAL,
					sender: account,
					keypair: keypair,
					nonce: query.nonce,
					points: query.points,
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

module.exports = Reveal;
