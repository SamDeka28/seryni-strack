import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import db from "../db.server";

const shop = process.env.SHOP;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    console.log("Starting subscription order sync...");
    let hasNextPage = true;
    let cursor = null;
    let processedOrders = 0;
    let errors = [];

    while (hasNextPage) {
      // 1) Fetch orders page
      const response = await admin.graphql(
        `
          query ($cursor: String) {
            orders(first: 20, after: $cursor, query: "financial_status:paid") {
              edges {
                node {
                  id
                  tags
                  note
                  createdAt
                  customer { id }
                  lineItems(first: 10) {
                    edges {
                      node {
                        sellingPlan { sellingPlanId }
                        variant {
                          id
                          product { id }
                        }
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { variables: { cursor } }
      );

      const data = await response.json();
      if (data.errors) throw new Error(JSON.stringify(data.errors));

      const orders = data.data.orders;
      console.log(`Fetched ${orders.edges.length} orders`);

      // 2) Process each order
      for (const edge of orders.edges) {
        const order = edge.node;

        const sellingPlanEdge = order.lineItems.edges.find(
          (e) => e.node.sellingPlan?.sellingPlanId
        );

        if (sellingPlanEdge) {
          try {
            const variant = sellingPlanEdge.node.variant;

            const result = await processOrder({
              order,
              sellingPlanId: sellingPlanEdge.node.sellingPlan.sellingPlanId,
              productId: variant?.product?.id || "",
              variantId: variant?.id || "",
              admin,
            });

            processedOrders++;
            console.log(`Processed order ${order.id}: cycle ${result.cycle}`);
          } catch (error) {
            console.error("Order failed:", error);
            errors.push(`Order ${order.id}: ${error.message}`);
          }
        }
      }

      hasNextPage = orders.pageInfo.hasNextPage;
      cursor = orders.pageInfo.endCursor;
    }

    return json({
      success: true,
      processedOrders,
      errors,
      message: `Processed ${processedOrders} orders${
        errors.length ? ` with ${errors.length} errors` : ""
      }`,
    });
  } catch (error) {
    console.error("Sync failed:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};

/**
 * Remove app-generated tags like "Monthly-Free-Gift" and "Monthly-order-X-no-Gifts"
 */
function stripAppTags(tags = []) {
  return tags.filter(
    (t) => !/^Monthly-(Free-Gift|order-\d+-no-Gifts)$/i.test(t)
  );
}

/**
 * Process an individual order:
 * - Fetch all orders for the customer
 * - Filter by sellingPlanId
 * - Compute cycle number
 * - Strip app tags + apply correct one
 * - Persist cycle in SubscriptionCycle table
 */
async function processOrder({ order, sellingPlanId, productId, variantId, admin }) {
  // Extract numeric customer ID from gid://shopify/Customer/123456789
  const customerGid = order.customer.id;
  const customerId = customerGid.split("/").pop();

  // 1) Fetch all orders for that customer via search
  const ordersResp = await admin.graphql(
    `
      query($search: String!) {
        orders(first: 250, query: $search) {
          edges {
            node {
              id
              createdAt
              tags
              lineItems(first: 50) {
                edges {
                  node {
                    sellingPlan { sellingPlanId }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { search: `customer_id:${customerId}` } }
  );

  const ordersData = await ordersResp.json();
  if (ordersData.errors) throw new Error(JSON.stringify(ordersData.errors));

  // 2) Filter relevant orders for this sellingPlan
  const relevantOrders = ordersData.data.orders.edges
    .map((e) => e.node)
    .filter((o) =>
      o.lineItems.edges.some(
        (li) => li.node.sellingPlan?.sellingPlanId === sellingPlanId
      )
    )
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // 3) Compute cycle number (index in order history)
  const cycle = relevantOrders.findIndex((o) => o.id === order.id) + 1;
  const tag =
    cycle === 1 ? "Monthly-Free-Gift" : `Monthly-order-${cycle}-no-Gifts`;

  // 4) Update subscriptionCycle table
  const subscriptionKey = `shop:${shop}::cust:${customerId}::sp:${sellingPlanId}`;
  await db.subscriptionCycle.upsert({
    where: { subscriptionKey },
    create: {
      shop,
      subscriptionKey,
      customerId,
      productId,
      variantId,
      cycle,
    },
    update: { cycle }, // overwrite with latest cycle
  });

  // 5) Clean tags and reapply
  const cleanedTags = stripAppTags(order.tags || []);
  const updatedTags = [...new Set([...cleanedTags, tag])];

  // 6) Update order in Shopify
  const mutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id tags note }
        userErrors { field message }
      }
    }
  `;

  const result = await admin.graphql(mutation, {
    variables: {
      input: {
        id: order.id,
        tags: updatedTags,
        note: tag,
      },
    },
  });

  const resultData = await result.json();
  if (resultData.errors) throw new Error(JSON.stringify(resultData.errors));
  if (resultData.data.orderUpdate.userErrors?.length > 0) {
    throw new Error(resultData.data.orderUpdate.userErrors[0].message);
  }

  return { cycle, tags: updatedTags, note: tag };
}

export const loader = () => {
  return json({ message: "Method not allowed" }, { status: 405 });
};
