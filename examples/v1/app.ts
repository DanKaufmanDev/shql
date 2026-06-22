import { connect, materialize } from "shql";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);

const db = await connect({
  schema: new URL("./database.shql", import.meta.url).pathname,
  auth: {
    type: "service-account",
    clientEmail: credentials.client_email,
    privateKey: credentials.private_key,
  },
});

const report = await db.query(`
  FROM orders AS o
  JOIN customers AS c ON o.customer_id = c._shql_id
  WHERE o.status = "paid"
  GROUP BY c._shql_id
  SELECT c._shql_id AS customer_id, SUM(o.total) AS revenue
  SORT revenue DESC
`);

console.log(report.rows);

await materialize(
  db,
  `
    FROM active_customers
    SELECT email, name, CASE
      WHEN spend >= 1000 THEN "enterprise"
      WHEN spend >= 250 THEN "growth"
      ELSE "standard"
    END AS segment
  `,
  "customer_export",
  { mode: "merge", key: "email", dryRun: true },
);
