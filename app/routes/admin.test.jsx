import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import db from "../db.server";

const shop = process.env.SHOP;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    console.log("Starting subscription order sync...");

    return json({
      success: true,
      message: `Processed Test api`
    });
  } catch (error) {
    console.error("Sync failed:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};


export const loader = () => {
  return json({ message: "Method not allowed" }, { status: 405 });
};
