import { authenticate } from "../shopify.server";
import db from "../db.server";

const shop = process.env.SHOP;

export const action = async ({ request }) => {
  try {
    const { topic, payload, session } = await authenticate.webhook(request);

    if (topic !== "ORDERS_CREATE") {
      return new Response("Ignored", { status: 200 });
    }

    if (!session?.accessToken) {
      console.error(`No offline session for ${shop}`);
      return new Response("No session", { status: 401 });
    }

    // Helper to call Admin GraphQL
    async function shopifyGraphQL(query, variables = {}) {
      const res = await fetch(
        `https://${shop}.myshopify.com/admin/api/${session.apiVersion || "2025-01"}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({ query, variables }),
        }
      );
      const json = await res.json();
      if (!res.ok || json.errors) {
        console.error("GraphQL error:", json.errors || json);
        throw new Response("GraphQL error", { status: 500 });
      }
      return json.data;
    }

    const orderGid = payload.admin_graphql_api_id;
    if (!orderGid) {
      console.log("No order GID in payload");
      return new Response("OK", { status: 200 });
    }

    // Fetch fresh order with sellingPlan info
    const GET_ORDER = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          tags
          note
          customer {
            id
            displayName
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                sellingPlan { sellingPlanId name }
                variant {
                  id
                  sku
                  product { id title }
                }
              }
            }
          }
        }
      }
    `;
    const orderData = await shopifyGraphQL(GET_ORDER, { id: orderGid });
    const order = orderData.order;
    const existingTags = (order.tags || []).map((t) => t.trim()).filter(Boolean);

    const subscriptionItem = order.lineItems.edges.find(
      (edge) => edge.node.sellingPlan?.sellingPlanId
    );
    const sellingPlanId = subscriptionItem?.node?.sellingPlan?.sellingPlanId || null;
    const firstItem = order.lineItems.edges[0]?.node;
    const customer = order.customer;

    const ORDER_UPDATE = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id tags note }
          userErrors { field message }
        }
      }
    `;

    /**
     * 1️⃣ One-Time Order → update customer metafield (track purchased products)
     */
    if (!sellingPlanId) {
      const oneTimeTag = "One-Time";
      const updatedTags = Array.from(new Set([...existingTags, oneTimeTag]));

      await shopifyGraphQL(ORDER_UPDATE, {
        input: {
          id: orderGid,
          tags: updatedTags,
          note: oneTimeTag,
        },
      });

      console.log("No selling plan — tagged as One-Time.");

      if (customer?.id) {
        // Collect product IDs
        const productIds = order.lineItems.edges.map(
          (edge) => edge.node.variant?.product?.id
        );

        // Get existing metafield
        const GET_CUSTOMER_METAFIELD = `
          query($id: ID!) {
            customer(id: $id) {
              metafield(namespace: "seryni", key: "purchased_products") {
                id
                value
              }
            }
          }
        `;
        const mfData = await shopifyGraphQL(GET_CUSTOMER_METAFIELD, { id: customer.id });
        let purchased = [];
        if (mfData.customer?.metafield?.value) {
          try {
            purchased = JSON.parse(mfData.customer.metafield.value);
          } catch {
            purchased = [];
          }
        }

        // Merge & dedupe
        const updated = Array.from(new Set([...purchased, ...productIds]));

        // Upsert metafield
        const UPSERT_METAFIELD = `
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id key namespace value }
              userErrors { field message }
            }
          }
        `;
        await shopifyGraphQL(UPSERT_METAFIELD, {
          metafields: [
            {
              namespace: "seryni",
              key: "purchased_products",
              type: "json",
              ownerId: customer.id,
              value: JSON.stringify(updated),
            },
          ],
        });

        console.log(`✅ Updated purchased_products metafield for ${customer.id}`, updated);
      }

      return new Response("OK", { status: 200 });
    }

    /**
     * 2️⃣ Subscription Order → update subscriptionCycle table + order tags
     */
    const subscriptionKey = `shop:${shop}::cust:${customer.id.split("/").pop()}::sp:${sellingPlanId}`;
    let record = await db.subscriptionCycle.findUnique({
      where: { subscriptionKey },
    });

    let cycle = 1;
    if (!record) {
      await db.subscriptionCycle.create({
        data: {
          shop,
          subscriptionKey,
          customerId: String(customer.id ?? ""),
          productId: String(firstItem?.variant?.product?.id ?? ""),
          variantId: String(firstItem?.variant?.id ?? ""),
          cycle: 1,
        },
      });
    } else {
      cycle = record.cycle + 1;
      await db.subscriptionCycle.update({
        where: { subscriptionKey },
        data: { cycle },
      });
    }

    const tag = cycle === 1 ? "Monthly-Free-Gift" : `Monthly-order-${cycle}-no-Gifts`;
    const updatedTags = Array.from(new Set([...existingTags, tag]));

    await shopifyGraphQL(ORDER_UPDATE, {
      input: {
        id: orderGid,
        tags: updatedTags,
        note: tag,
      },
    });

    console.log(`Order tagged as: ${tag}`);
  } catch (err) {
    console.error("ORDER WEBHOOK FAILED", err);
  }

  return new Response("OK", { status: 200 });
};
