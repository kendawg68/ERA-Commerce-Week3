require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const {connectMongo, getMongo} = require("./mongo");
const authenticateToken = require("./middleware/authenticateToken");
const authorizeRole = require("./middleware/authorizeRole");

const app = express();
const PORT = 3000;
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({ message: "eracommerce API is running"});
});

async function startServer() {
    await connectMongo();
    app.listen(PORT, () => {
        console.log(`server running at http://localhost:${PORT}`);
    });
}

// POST /login
app.post("/login", (req, res) => {
    const {email, password} = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: "email and password are required"});
    }
    const sql = "SELECT * FROM users WHERE email = ?";
    db.query(sql, [email], async(err, results) => {
        if (err) return res.status(500).json({ message: "server error"});
        if (results.length === 0) {
            return res.status(401).json({ message: "invalid email or password"});
        }
        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: "invalid email or password"});
        }
        const token = jwt.sign({
            id: user.id,
            email: user.email,
            role: user.role 
    },
    process.env.JWT_SECRET,
    {expiresIn: process.env.JWT_EXPIRES_IN}
);
    res.json({
        message: "login successful",
        token,
        user: {id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email, role: user.role}
    });
    });
});

// POST /users(register)
app.post("/users", async (req, res) => {
    const {first_name, last_name, email, password} = req.body;
    if (!first_name || !last_name || !email || !password) {
        return res.status(400).json({ message: "all fields are required"});
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (first_name, last_name, email, password) VALUES (?, ?, ?, ?)";
        db.query(sql, [first_name, last_name, email, hashedPassword], (err, result) => {
            if (err) {
                if (err.code === "ER_DUP_ENTRY") {
                    return res.status(400).json({ message: "email already registered"});
                }
                return res.status(500).json({ message: "server error"});
            }
            res.status(201).json({ message: "user registered successfully", userId: result.insertId});
        });
    } catch (err) {
        res.status(500).json({ message: "server error"});
    }
});

// GET /products
app.get("/products", authenticateToken, (req, res) => {
    const sql = "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id ORDER BY p.id ASC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ message: "server error"});
        res.json(results);
    });
});

// GET /products/category/:categoryId
app.get("/products/category/:categoryId", authenticateToken, (req, res) => {
    const {categoryId} = req.params;
    const sql = "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id = c.id WHERE p.category_id = ? ORDER BY p.id ASC";
    db.query(sql, [categoryId], (err, results) => {
        if (err) return res.status(500).json({ message: "server error"});
        res.json(results);
    });
});

// GET /products/:id
app.get("/products/:id", authenticateToken, async(req, res) => {
    const {id} = req.params;
    const sql = "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id = c.id WHERE p.id = ?";
    db.query(sql, [id], async(err, results) => {
        if (err) return res.status(500).json({ message: "server error"});
        if (results.length === 0) {
            return res.status(404).json({ message: "product not found"});
        }
        const product = results[0];
        try {
            const mongo = getMongo();
            const reviews = await mongo.collection("product_reviews").find({product_id: parseInt(id)}).toArray();
            res.json({...product, reviews});
        } catch (mongoErr) {
            res.json({...product, reviews: []});
        }
    });
});

// POST /products - admin only
app.post("/products", authenticateToken, authorizeRole("admin"), async(req, res) => {
    const {name, description, price, stock_quantity, category_id} = req.body;
    if (!name || !price || !category_id) {
        return res.status(400).json({ message: "name, price, and category id are required"});
    }
    const sql = "INSERT INTO products (name, description, price, stock_quantity, category_id) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [name, description, price, stock_quantity || 0, category_id], async(err, result) => {
        if (err) return res.status(500).json({ message: "server error"});
        try {
            const mongo = getMongo();
            await mongo.collection("inventory_logs").insertOne({
                product_id: result.insertId,
                product_name: name,
                action: "restocked",
                quantity_change: stock_quantity || 0,
                previous_stock: 0,
                new_stock: stock_quantity || 0,
                timestamp: new Date()
            });
        } catch (mongoErr) {
            console.error("mongoDB log failed:", mongoErr.message);
        }
        res.status(201).json({ message: "product created", productId: result.insertId});
    });
});

// POST /orders
app.post("/orders", authenticateToken, async(req, res) => {
    const {items} = req.body || {};
    const userId = req.user.id;
    if (!items || items.length === 0) {
        return res.status(400).json({ message: "order must contain at least 1 item"});
    }
    db.beginTransaction(async(err) => {
        if (err) return res.status(500).json({ message: "server error"});
        try {
            // step 1: calculate total amount
            let totalAmount = 0;
            for (const item of items) {
                totalAmount += item.price_at_purchase * item.quantity;
            }
            // step 2: insert into orders
            const orderSql = "INSERT INTO orders(user_id, total_amount) VALUES (?, ?)";
            const orderResult = await new Promise((resolve, reject) => {
                db.query(orderSql, [userId, totalAmount], (err, result) => {
                    if (err) reject(err); else resolve(result);
                });
            });
            const orderId = orderResult.insertId;
            // step 3: insert order_items and update stock
            for (const item of items) {
                const {product_id, quantity, price_at_purchase} = item;
                const subTotal = quantity * price_at_purchase;
                await new Promise((resolve, reject) => {
                    const itemSql = "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, subtotal) VALUES (?, ?, ?, ?, ?)";
                    db.query(itemSql, [orderId, product_id, quantity, price_at_purchase, subtotal], (err, r) => {
                        if (err) reject(err); else resolve(r);
                    });
                });
                    await new Promise((resolve, reject) => {
                        const stockSql = "UPDATE products SET stock_quantity = stock_quantity >= ?";
                        db.query(stockSql, [quantity, product_id, quantity], (err, r) => {
                            if (err) reject (err);
                            else if (r.affectedRows === 0) reject(new Error("insufficient stock"));
                            else resolve(r);
                        });
                    });
                }
                // step 4: commit
                db.commit(async(err) => {
                    if (err) {
                        return db.rollback(() => {
                            res.status(500).json({ message: "commit failed"});
                        });
                    }
                    // step 5: auto log to mongoDB after commit
                    try {
                        const mongo = getMongo();
                        for(const item of items) {
                            await mongo.collection("inventory_logs").insertOne({
                                product_id: item.product_id,
                                action: "sold",
                                quantity_change: -item.quantity,
                                timestamp: new Date()
                            });
                        }
                    } catch (mongoErr) {
                        console.error("mongoDb log failed:", mongoErr.message);
                    }
                    res.status(201).json({ message: "order placed", orderId});
                });
            } catch (err) {
                // step 6: rollback on any error
                db.rollback(() => {
                    res.status(400).json({ message: err.message || "order failed"});
                });
            
        }
    });
});

// GET /categories
app.get("/categories", authenticateToken, (req, res) => {
    const sql = "SELECT c.id, c.name, c.description, COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id, c.name, c.description ORDER BY c.id ASC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ message: "server error"});
        res.json(results);
    });
});

startServer();