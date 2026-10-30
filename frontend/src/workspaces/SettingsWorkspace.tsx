import AdminSettings from "../AdminSettings";
import SalesDesk from "../SalesDesk";
import { campaignsService } from "../campaignsService";
import type { MarketingConnections } from "../marketing/useMarketingConnections";
export default function SettingsWorkspace({
  token,
  connections,
  setNotice,
  setError,
  handleError,
}: {
  token: string;
  connections: MarketingConnections;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  handleError: (error: unknown) => void;
}) {
  const {
    integrations,
    facebookPages,
    selectedFacebookPage,
    campaignTypes,
    busy,
    setSelectedFacebookPage,
    connectInstagram,
    checkInstagramConnection,
    disconnectInstagram,
    connectFacebook,
    chooseFacebookPage,
    disconnectFacebook,
    checkFacebookConnection,
  } = connections;
  return (
    <>
      {" "}
      <AdminSettings
        salesDeskConfiguration={
          <SalesDesk
            page="App Settings"
            embedded
            token={token}
            setNotice={setNotice}
            setError={setError}
          />
        }
        integrations={integrations}
        facebookPages={facebookPages}
        selectedFacebookPage={selectedFacebookPage}
        setSelectedFacebookPage={setSelectedFacebookPage}
        busy={busy}
        connectFacebook={connectFacebook}
        chooseFacebookPage={chooseFacebookPage}
        checkFacebookConnection={checkFacebookConnection}
        disconnectFacebook={disconnectFacebook}
        connectInstagram={connectInstagram}
        checkInstagramConnection={checkInstagramConnection}
        disconnectInstagram={disconnectInstagram}
        campaignTypes={campaignTypes}
        addCampaignType={async (name) => {
          try {
            await campaignsService.addType(name);
            await connections.load();
            setNotice("Campaign type added.");
            return true;
          } catch (e) {
            handleError(e);
            return false;
          }
        }}
        deleteCampaignType={async (name) => {
          try {
            await campaignsService.removeType(name);
            await connections.load();
            setNotice("Campaign type removed.");
            return true;
          } catch (e) {
            handleError(e);
            return false;
          }
        }}
        reorderCampaignTypes={async (names) => {
          try {
            await campaignsService.reorderTypes(names);
            await connections.load();
            setNotice("Campaign types reordered.");
            return true;
          } catch (e) {
            handleError(e);
            return false;
          }
        }}
        setNotice={setNotice}
        setError={setError}
      />
    </>
  );
}
