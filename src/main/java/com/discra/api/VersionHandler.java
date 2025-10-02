package com.discra.api;

import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;

import java.time.Instant;
import java.util.Map;

public class VersionHandler implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse> {
	private static final String VERSION = "0.0.1-tracer";
	
	@Override
	public APIGatewayV2HTTPResponse handleRequest(APIGatewayV2HTTPEvent event, Context context) {
		String body = String.format("{\"version\":\"%s\",\"deployed_at\":\"%s\"}", VERSION, Instant.now());
		return APIGatewayV2HTTPResponse.builder()
				.withStatusCode(200)
				.withHeaders(Map.of(
						"Content-Type", "application/json",
						"Access-Control-Allow-Origin", "*",
						"Access-Control-Allow-Methods", "GET, OPTIONS",
						"Access-Control-Allow-Headers", "Content-Type"))
				.withBody(body)
				.build();
	}

}
