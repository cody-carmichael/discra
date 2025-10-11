package discra.api;

import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;

import java.util.Map;



public class AdminPingHandler implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse>{
	
	@Override
	public APIGatewayV2HTTPResponse handleRequest(APIGatewayV2HTTPEvent event, Context context) {
		String expected = System.getenv("ADMIN_TOKEN");
		String got = null;
		
		if (event != null && event.getHeaders() != null) {
			//API Gateway (HTTP API v2) typically lowercases header keys
			got = event.getHeaders().getOrDefault("x-admin-token", event.getHeaders().get("X-Admin-Token"));
		}
		
		//fail fast if token is not provided
		if (expected == null || expected.isBlank()) {
			return APIGatewayV2HTTPResponse.builder()
					.withStatusCode(500)
					.withBody("{\"error\":\"admin token not configured\"}")
					.withHeaders(Map.of("Content-Type","application/json","Access-Control-Allow-Origin","*"))
					.build();
		}
		
		//fail if token isn't valid
		if (got == null || !got.equals(expected)) {
			return APIGatewayV2HTTPResponse.builder()
	                .withStatusCode(401)
	                .withBody("{\"error\":\"unauthorized\"}")
	                .withHeaders(Map.of("Content-Type","application/json","Access-Control-Allow-Origin","*"))
	                .build();
		}
		
		//return success if valid token
		return APIGatewayV2HTTPResponse.builder()
				.withStatusCode(200)
				.withBody("{\"ok\":true,\"route\":\"/admin/ping\"}")
	            .withHeaders(Map.of("Content-Type","application/json","Access-Control-Allow-Origin","*"))
	            .build();
	}

}
