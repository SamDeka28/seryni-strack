import { useFetcher } from "@remix-run/react";
import { BlockStack, Button, Card, Layout, Page, Text } from "@shopify/polaris";
import { useEffect } from "react";

export default function SyncSubscription() {
  const fetcher = useFetcher();
  const isRunning = fetcher.state === "submitting";

  // Debugging effect
  useEffect(() => {
    console.log('Fetcher state:', fetcher.state);
    if (fetcher.data) console.log('Response data:', fetcher.data);
    if (fetcher.error) console.error('Error:', fetcher.error);
  }, [fetcher.state, fetcher.data, fetcher.error]);

  const handleSubmit = async () => {
    console.log('Manual submission triggered');
    try {
      await fetcher.submit(
        {}, 
        { 
          method: 'POST', 
          action: '/admin/syncsubscription/api',
          encType: 'application/json'
        }
      );
    } catch (error) {
      console.error('Submission error:', error);
    }
  };

  return (
    <Page>
      <Layout>
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Sync Your Orders for Existing Customers
            </Text>
            

            {/* Option 2: Manual submission */}
            <Button
              primary
              loading={isRunning}
              onClick={handleSubmit}
            >
              Sync All Orders
            </Button>

            {fetcher.data && (
              <Text color={fetcher.data.success ? "success" : "critical"}>
                {fetcher.data.success
                  ? `✅ ${fetcher.data.processedOrders} orders processed`
                  : `❌ Error: ${fetcher.data.error}`}
              </Text>
            )}
          </BlockStack>
        </Card>
      </Layout>
    </Page>
  );
}