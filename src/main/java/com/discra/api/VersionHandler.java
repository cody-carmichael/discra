package com.discra.api;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;

import java.util.Map;

public class VersionHandler implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse> {
    @Override
    public APIGatewayV2HTTPResponse handleRequest(APIGatewayV2HTTPEvent event, Context context) {
        String version = System.getenv().getOrDefault("VERSION", "dev");
        System.out.println("VersionHandler invoked, VERSION=" + version); // basic log
        return APIGatewayV2HTTPResponse.builder()
                .withStatusCode(200)
                .withBody("{\"version\":\"" + version + "\"}")
                .withHeaders(Map.of("Content-Type","application/json","Access-Control-Allow-Origin","*"))
                .build();
    }
}